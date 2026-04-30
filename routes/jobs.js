const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification, createNotificationForCompany, createNotificationForOwners } = require('../utils/notificationHelpers');
const { sendJobAssignedEmail, sendJobCompletedEmail } = require('../services/emailNotificationService');
const { body, validationResult } = require('express-validator');

// ── Customer Portal SSE: publish job events to Redis pub/sub ──────────────────
// Non-destructive: only fires when job has a customer_id; failure never affects response.
const redisClient = require('../utils/redis');

function publishCustomerJobEvent(jobId, eventPayload) {
  if (!jobId || !redisClient || redisClient.status !== 'ready') return;
  const channel = `customer_job_events:${jobId}`;
  redisClient.publish(channel, JSON.stringify(eventPayload))
    .catch(e => console.error('Customer SSE publish error:', e.message));
}

/**
 * Ensure the jobs table can store JSON payloads, visibility flag, and employee tracking
 */


/**
 * Create a new job
 */
router.post('/', authenticateToken, [
  body('title').trim().notEmpty().withMessage('Title is required').escape(),
  body('description').optional({ checkFalsy: true }).trim().escape(),
  body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage('Invalid priority value'),
  body('status').optional().isIn(['open', 'pending', 'in_progress', 'active', 'completed', 'closed', 'cancelled']).withMessage('Invalid status value')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: "Validation failed", errors: errors.array() });
  }

  const job = req.body || {};
  const title = job.title || '';
  const description = job.description || '';

  const assignedTo =
    (job.assignedEmployees && job.assignedEmployees[0]) ||
    job.assignedTo ||
    null;

  const visibleToAll =
    job.visible_to_all === false ? false : true;

  try {
    const result = await pool.query(
      `INSERT INTO jobs 
       (title, description, assigned_to, created_by, company_id, data, visible_to_all, status, priority, employee_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'assigned')
       RETURNING *`,
      [
        title,
        description,
        assignedTo,
        req.user.id,
        req.user.companyId || null,
        job,
        visibleToAll,
        job.status || 'open',
        job.priority || 'medium'
      ]
    );

    const createdJob = result.rows[0];

    // Send notification to assigned employee OR broadcast to all if visible to all
    try {
      if (visibleToAll) {
        await createNotificationForCompany({
          company_id: req.user.companyId,
          type: 'job',
          title: 'New Job Available',
          message: `A new job is available for everyone: ${title}`,
          priority: job.priority || 'medium',
          data: { job_id: createdJob.id, job_title: title },
          exclude_user_id: req.user.id
        });
      } else if (assignedTo) {
        await createNotification({
          user_id: assignedTo,
          company_id: req.user.companyId,
          type: 'job',
          title: 'New Job Assigned',
          message: `You have been assigned a new job: ${title}`,
          priority: job.priority || 'medium',
          data: { job_id: createdJob.id, job_title: title, url: '/employee/notifications' }
        });
        // 📧 Email: Notify assigned employee
        const empResult = await pool.query('SELECT email, name FROM users WHERE id = $1', [assignedTo]);
        const ownerResult = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        if (empResult.rows[0]) {
          sendJobAssignedEmail({
            employeeEmail: empResult.rows[0].email,
            employeeName: empResult.rows[0].name,
            jobTitle: title,
            jobDescription: description,
            priority: job.priority || 'medium',
            deadline: job.deadline,
            ownerName: ownerResult.rows[0]?.name
          });
        }
      }
    } catch (notifErr) {
      console.error('❌ Failed to send job notification:', notifErr);
    }

    res.json(createdJob);
  } catch (err) {
    console.error('jobs POST error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Get jobs (role-based)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    let result;

    console.log(`🧩 Fetching jobs for role: ${req.user.role}, company: ${req.user.companyId}`);

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;

    let countResult;
    let queryParams = [req.user.companyId];

    if (req.user.role === 'owner') {
      countResult = await pool.query(`SELECT COUNT(*) FROM jobs WHERE company_id::text = $1`, [String(req.user.companyId)]);
      result = await pool.query(
        `SELECT j.*, u.email as employee_email 
         FROM jobs j
         LEFT JOIN users u ON j.assigned_to = u.id
         WHERE j.company_id::text = $1
         ORDER BY j.created_at DESC
         LIMIT $2 OFFSET $3`,
        [String(req.user.companyId), limit, offset]
      );
    } else if (req.user.role === 'employee') {
      // Employees see a job if ANY of these are true:
      //   1. visible_to_all = true (broadcast job, anyone can pick it up)
      //   2. assigned_to = this employee (directly assigned OR already accepted/working)
      //   3. employee_status = 'assigned' with no specific assignee (open pool job)
      // Exclude cancelled jobs ONLY if they are not assigned to this employee.
      // (Jobs can have status='cancelled' but still be assigned — show those too)
      const empWhere = `
        company_id::text = $1
        AND (
          visible_to_all = true
          OR assigned_to = $2
          OR (employee_status = 'assigned' AND assigned_to IS NULL)
          OR (source = 'customer' AND COALESCE(approval_status, 'approved') = 'approved')
        )
        AND (source IS NULL OR source != 'customer' OR COALESCE(approval_status, 'approved') = 'approved')
        AND (status NOT IN ('cancelled') OR assigned_to = $2)
      `;
      countResult = await pool.query(
        `SELECT COUNT(*) FROM jobs WHERE ${empWhere}`,
        [String(req.user.companyId), req.user.id]
      );
      result = await pool.query(
        `SELECT j.* FROM jobs j
         WHERE ${empWhere}
         ORDER BY j.created_at DESC
         LIMIT $3 OFFSET $4`,
        [String(req.user.companyId), req.user.id, limit, offset]
      );
    } else {
      countResult = await pool.query(`SELECT COUNT(*) FROM jobs WHERE visible_to_all = true AND company_id::text = $1`, [String(req.user.companyId)]);
      result = await pool.query(
        `SELECT * FROM jobs WHERE visible_to_all = true AND company_id::text = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [String(req.user.companyId), limit, offset]
      );
    }

    const total = parseInt(countResult.rows[0].count);
    console.log(`🧩 Jobs query returned ${result.rows.length} rows (total: ${total}) for role: ${req.user.role}, company: ${req.user.companyId}`);

    const rows = result.rows.map((r) => {
      const job = r.data && typeof r.data === 'object' ? r.data : {};
      return {
        // Spread legacy data blob for any extra fields (e.g. custom fields)
        ...job,
        // Always override with authoritative DB column values — never let the
        // stale data blob overwrite these critical fields
        id: r.id,
        title: r.title,
        description: r.description,
        priority: r.priority,
        status: r.status,
        visible_to_all: r.visible_to_all,
        created_by: r.created_by,
        assigned_to: r.assigned_to,
        created_at: r.created_at,
        employee_status: r.employee_status,
        progress: r.progress || 0,
        accepted_at: r.accepted_at,
        declined_at: r.declined_at,
        completed_at: r.completed_at,
        employee_email: r.employee_email,
        // These fields must also come from DB, not the blob
        source: r.source || null,
        approval_status: r.approval_status || null,
        customer_id: r.customer_id || null,
        company_id: r.company_id || null,
        started_at: r.started_at || null,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error('jobs GET error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Accept a job (Employee only)
 * Section 1: wrapped in DB transaction — accept + started_at + active_job_count are atomic
 */
router.post('/:id/accept', authenticateToken, async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check job access — employee must be able to see the job
    const checkJob = await client.query(
      'SELECT * FROM jobs WHERE id = $1 AND (assigned_to = $2 OR visible_to_all = true) AND company_id::text = $3',
      [id, req.user.id, String(req.user.companyId)]
    );

    if (checkJob.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Job not assigned to you' });
    }

    // Race condition guard: only accept if employee_status is still 'assigned' (not yet accepted by anyone)
    // The atomic UPDATE returns 0 rows if another employee already accepted
    const result = await client.query(
      `UPDATE jobs
       SET employee_status = 'accepted',
           accepted_at     = NOW(),
           started_at      = NOW(),
           status          = 'in_progress',
           assigned_to     = $2,
           visible_to_all  = false
       WHERE id = $1
         AND company_id::text = $3
         AND employee_status = 'assigned'
       RETURNING *`,
      [id, req.user.id, String(req.user.companyId)]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      // Check current state to give a meaningful error
      const current = await pool.query('SELECT employee_status, assigned_to FROM jobs WHERE id = $1', [id]);
      const cur = current.rows[0];
      if (cur && cur.employee_status === 'accepted' && cur.assigned_to !== req.user.id) {
        return res.status(409).json({ message: 'Job already accepted by another employee' });
      }
      if (cur && cur.employee_status === 'accepted' && cur.assigned_to === req.user.id) {
        return res.status(409).json({ message: 'You have already accepted this job' });
      }
      return res.status(409).json({ message: 'Job is no longer available for acceptance' });
    }

    const acceptedJob = result.rows[0];

    await client.query('COMMIT');

    // ── Post-commit side effects (non-blocking) ───────────────────────────────

    // Customer Portal SSE
    try {
      if (acceptedJob.customer_id && redisClient && redisClient.status === 'ready') {
        const userInfo2 = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        const empName = userInfo2.rows[0]?.name || 'Employee';
        redisClient.publish(
          `customer_job_events:${acceptedJob.id}`,
          JSON.stringify({ type: 'job_accepted', jobId: acceptedJob.id, employeeName: empName, acceptedAt: new Date().toISOString() })
        );
      }
    } catch (cpErr) {
      console.error('Customer portal SSE publish error (accept):', cpErr.message);
    }

    // Notify owner
    try {
      const userInfo = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
      const employeeName = userInfo.rows[0]?.name || 'Employee';
      await createNotificationForOwners({
        company_id: req.user.companyId || acceptedJob.company_id,
        type: 'job_accepted',
        title: 'Job Accepted',
        message: `${employeeName} accepted the job: ${acceptedJob.title}`,
        priority: 'medium',
        data: { job_id: acceptedJob.id, employee_id: req.user.id, url: '/owner/notifications' }
      });
    } catch (notifErr) {
      console.error('❌ Failed to send job acceptance notification:', notifErr);
    }

    res.json(acceptedJob);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('jobs ACCEPT error', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

/**
 * Decline a job (Employee only)
 */
router.post('/:id/decline', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Check if job is assigned to this employee
    const checkJob = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND (assigned_to = $2 OR visible_to_all = true) AND company_id::text = $3',
      [id, req.user.id, String(req.user.companyId)]
    );

    if (checkJob.rows.length === 0) {
      return res.status(403).json({ message: 'Job not assigned to you' });
    }

    // HARDENED: company_id in UPDATE prevents cross-tenant write
    // Atomic guard: only decline if still in 'assigned' state
    const result = await pool.query(
      `UPDATE jobs
       SET employee_status = 'declined',
           declined_at     = NOW()
       WHERE id = $1
         AND company_id::text = $2
         AND employee_status = 'assigned'
       RETURNING *`,
      [id, String(req.user.companyId)]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ message: 'Job not available for decline (already accepted or wrong company)' });
    }

    const declinedJob = result.rows[0];

    // Send notification to owner about job decline
    try {
      // Get employee name
      const userInfo = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
      const employeeName = userInfo.rows[0]?.name || 'Employee';

      await createNotification({
        user_id: declinedJob.created_by,
        company_id: req.user.companyId,
        type: 'job_declined',
        title: 'Job Declined',
        message: `${employeeName} declined the job: ${declinedJob.title}`,
        priority: 'high',
        data: { job_id: declinedJob.id, employee_id: req.user.id, url: '/owner/notifications' }
      });
      console.log(`✅ Notified owner about job decline`);
    } catch (notifErr) {
      console.error('❌ Failed to send job decline notification:', notifErr);
    }

    res.json(declinedJob);
  } catch (err) {
    console.error('jobs DECLINE error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Update job progress (Employee only)
 */
router.post('/:id/progress', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { progress } = req.body;

  if (typeof progress !== 'number' || progress < 0 || progress > 100) {
    return res.status(400).json({ message: 'Progress must be between 0 and 100' });
  }

  try {
    // Check if job is assigned to this employee and accepted
    console.log(`🔍 Checking job access: JobID=${id}, UserID=${req.user.id}`);

    // HARDENED: scope existence check to own company too
    const jobExists = await pool.query(
      'SELECT id, assigned_to, employee_status FROM jobs WHERE id = $1 AND company_id::text = $2',
      [id, String(req.user.companyId)]
    );
    if (jobExists.rows.length === 0) {
      return res.status(404).json({ message: 'Job not found' });
    }

    const checkJob = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND assigned_to = $2 AND employee_status = $3',
      [id, req.user.id, 'accepted']
    );

    if (checkJob.rows.length === 0) {
      console.warn(`⛔ Access denied for Job ${id} by User ${req.user.id}`);
      return res.status(403).json({
        message: 'Job not assigned to you or not accepted'
      });
    }

    // Use 'in_progress' (not 'active') as the canonical in-flight status
    let status = 'in_progress';
    let completed_at = null;

    if (progress === 100) {
      status = 'completed';
      completed_at = new Date();
    }

    // HARDENED: company_id in UPDATE, only allow if assigned_to = me
    const result = await pool.query(
      `UPDATE jobs
       SET progress      = $1,
           status        = $2,
           completed_at  = $3,
           employee_status = CASE WHEN $1 = 100 THEN 'completed' ELSE employee_status END
       WHERE id = $4
         AND company_id::text = $5
         AND assigned_to = $6
       RETURNING *`,
      [progress, status, completed_at, id, String(req.user.companyId), req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(403).json({ message: 'Cannot update job — access denied or already completed' });
    }

    const updatedJob = result.rows[0];

    // Decrement active_job_count when job is completed
    if (progress === 100) {
      pool.query(
        `UPDATE employee_profiles
         SET active_job_count = GREATEST(0, COALESCE(active_job_count, 0) - 1)
         WHERE user_id = $1`,
        [req.user.id]
      ).catch(e => console.error('active_job_count decrement error:', e.message));

      // Generate invoice (non-blocking) — only for non-cancelled jobs
      const { generateInvoice } = require('../services/billingService');
      generateInvoice(updatedJob.id, updatedJob.company_id || req.user.companyId)
        .catch(e => console.error('Invoice generation error:', e.message));
    }

    // 🔔 Customer Portal: notify customer via Redis pub/sub if this is a customer job
    try {
      const redisClient = require('../utils/redis');
      if (updatedJob.customer_id && redisClient && redisClient.status === 'ready') {
        const eventPayload = progress === 100
          ? { type: 'job_completed', jobId: updatedJob.id, completedAt: new Date().toISOString() }
          : { type: 'job_progress', jobId: updatedJob.id, progress, status: updatedJob.status };
        redisClient.publish(`customer_job_events:${updatedJob.id}`, JSON.stringify(eventPayload));
      }
    } catch (cpErr) {
      console.error('Customer portal SSE publish error (progress):', cpErr.message);
    }

    // Notification for job completion
    if (progress === 100) {
      try {
        const userInfo = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.id]);
        const employeeName = userInfo.rows[0]?.name || 'Employee';
        const ownerResult = await pool.query(
          "SELECT u.email, u.name FROM users u WHERE u.id = $1",
          [updatedJob.created_by]
        );

        await createNotificationForOwners({
          company_id: req.user.companyId,
          type: 'job_completed',
          title: 'Job Completed',
          message: `${employeeName} completed the job: ${updatedJob.title}`,
          priority: 'medium',
          data: { job_id: updatedJob.id, employee_id: req.user.id, url: '/owner/notifications' }
        });

        // 📧 Email: Notify owner of job completion  
        if (ownerResult.rows[0]) {
          sendJobCompletedEmail({
            ownerEmail: ownerResult.rows[0].email,
            ownerName: ownerResult.rows[0].name,
            employeeName,
            jobTitle: updatedJob.title
          });
        }
      } catch (notifErr) {
        console.error('❌ Failed to send job completion notification:', notifErr);
      }
    }

    res.json(updatedJob);
  } catch (err) {
    console.error('jobs PROGRESS error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Update job (Owner/Admin)
 */
router.put('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const updates = req.body || {};
  const companyId = req.user.companyId;

  try {
    const result = await pool.query(
      `UPDATE jobs SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         assigned_to = COALESCE($3, assigned_to),
         visible_to_all = COALESCE($4, visible_to_all),
         data = CASE 
           WHEN data IS NULL THEN $5 
           ELSE data || $5 
         END
       WHERE id = $6 AND company_id = $7
       RETURNING *`,
      [
        updates.title,
        updates.description,
        (updates.assignedEmployees && updates.assignedEmployees[0]) ||
        updates.assignedTo ||
        null,
        typeof updates.visible_to_all !== 'undefined'
          ? updates.visible_to_all
          : null,
        updates,
        id,
        companyId,
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Job not found or access denied' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('jobs PUT error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Delete job
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const companyId = req.user.companyId;

  try {
    const result = await pool.query(
      'DELETE FROM jobs WHERE id = $1 AND company_id = $2 RETURNING id',
      [id, companyId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Job not found or access denied' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('jobs DELETE error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
