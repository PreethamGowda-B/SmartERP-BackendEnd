const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification, createNotificationForCompany } = require('../utils/notificationHelpers');
const { body, validationResult } = require('express-validator');

/**
 * Ensure the jobs table can store JSON payloads, visibility flag, and employee tracking
 */
const ensureColumns = async () => {
  if (!pool) {
    console.warn("⚠️ Database pool not ready yet. Skipping schema checks.");
    return;
  }

  try {
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS data JSONB");
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS visible_to_all BOOLEAN DEFAULT false");
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS employee_status VARCHAR(50) DEFAULT 'pending'");
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0");
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP");
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS declined_at TIMESTAMP");
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP");
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'medium'");
    await pool.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_id TEXT");
    console.log("✅ Jobs table schema verified.");
  } catch (err) {
    console.warn("⚠️ Could not ensure jobs columns exist:", err.message);
  }
};
setTimeout(ensureColumns, 5000);

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
       (title, description, assigned_to, created_by, company_id, data, visible_to_all, status, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
          exclude_user_id: req.user.id // Don't notify the owner who created it
        });
        console.log(`✅ Broadcast notification sent for new job: ${title}`);
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
        console.log(`✅ Specific notification sent to assigned employee for job: ${title}`);
      }
    } catch (notifErr) {
      console.error('❌ Failed to send job notification:', notifErr);
      // Don't fail the job creation if notification fails
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

    console.log("🧩 Fetching jobs for:", req.user);

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;

    let countResult;
    let queryParams = [req.user.companyId];

    if (req.user.role === 'owner') {
      countResult = await pool.query(`SELECT COUNT(*) FROM jobs WHERE company_id = $1`, [req.user.companyId]);
      result = await pool.query(
        `SELECT j.*, u.email as employee_email 
         FROM jobs j
         LEFT JOIN users u ON j.assigned_to = u.id
         WHERE j.company_id = $1
         ORDER BY j.created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.user.companyId, limit, offset]
      );
    } else if (req.user.role === 'employee') {
      countResult = await pool.query(
        `SELECT COUNT(*) FROM jobs WHERE (visible_to_all = true OR assigned_to = $1) AND company_id = $2`,
        [req.user.id, req.user.companyId]
      );
      result = await pool.query(
        `SELECT * FROM jobs 
         WHERE (visible_to_all = true OR assigned_to = $1)
         AND company_id = $2
         ORDER BY created_at DESC
         LIMIT $3 OFFSET $4`,
        [req.user.id, req.user.companyId, limit, offset]
      );
    } else {
      countResult = await pool.query(`SELECT COUNT(*) FROM jobs WHERE visible_to_all = true AND company_id = $1`, [req.user.companyId]);
      result = await pool.query(
        `SELECT * FROM jobs WHERE visible_to_all = true AND company_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.user.companyId, limit, offset]
      );
    }

    const total = parseInt(countResult.rows[0].count);

    const rows = result.rows.map((r) => {
      const job = r.data && typeof r.data === 'object' ? r.data : {};
      return {
        ...job,  // Spread job data first
        // Then override with database values (these take precedence)
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
 */
router.post('/:id/accept', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Check if job is assigned to this employee
    const checkJob = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND (assigned_to = $2 OR visible_to_all = true)',
      [id, req.user.id]
    );

    if (checkJob.rows.length === 0) {
      return res.status(403).json({ message: 'Job not assigned to you' });
    }

    const result = await pool.query(
      `UPDATE jobs 
       SET employee_status = 'accepted', 
           accepted_at = NOW(),
           status = 'active',
           assigned_to = $2
       WHERE id = $1
       RETURNING *`,
      [id, req.user.id]
    );

    const acceptedJob = result.rows[0];

    // Send notification to owner about job acceptance
    try {
      // Get employee name and job creator
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
      console.log(`✅ Notified owner(s) about job acceptance`);
    } catch (notifErr) {
      console.error('❌ Failed to send job acceptance notification:', notifErr);
    }

    res.json(acceptedJob);
  } catch (err) {
    console.error('jobs ACCEPT error', err);
    res.status(500).json({ message: 'Server error' });
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
      'SELECT * FROM jobs WHERE id = $1 AND (assigned_to = $2 OR visible_to_all = true)',
      [id, req.user.id]
    );

    if (checkJob.rows.length === 0) {
      return res.status(403).json({ message: 'Job not assigned to you' });
    }

    const result = await pool.query(
      `UPDATE jobs 
       SET employee_status = 'declined', 
           declined_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

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

    // First, check if job exists at all to differentiate 404 vs 403
    const jobExists = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    if (jobExists.rows.length === 0) {
      console.log(`❌ Job not found: ${id}`);
      return res.status(404).json({ message: 'Job not found' });
    }
    console.log(`   Job found. Assigned To: ${jobExists.rows[0].assigned_to}, Employee Status: ${jobExists.rows[0].employee_status}`);

    const checkJob = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND assigned_to = $2 AND employee_status = $3',
      [id, req.user.id, 'accepted']
    );

    if (checkJob.rows.length === 0) {
      console.warn(`⛔ Access Denied for Job ${id} by User ${req.user.id}. Job Assigned To: ${jobExists.rows[0].assigned_to}, Status: ${jobExists.rows[0].employee_status}`);
      return res.status(403).json({
        message: 'Job not assigned to you or not accepted',
        debug: {
          jobId: id,
          userId: req.user.id,
          assignedTo: jobExists.rows[0].assigned_to,
          employeeStatus: jobExists.rows[0].employee_status
        }
      });
    }

    let status = 'active';
    let completed_at = null;

    if (progress === 100) {
      status = 'completed';
      completed_at = new Date();
    }

    const result = await pool.query(
      `UPDATE jobs 
       SET progress = $1, 
           status = $2,
           completed_at = $3
       WHERE id = $4
       RETURNING *`,
      [progress, status, completed_at, id]
    );

    const updatedJob = result.rows[0];

    // Notification for job completion
    if (progress === 100) {
      try {
        // Get employee name
        const userInfo = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        const employeeName = userInfo.rows[0]?.name || 'Employee';

        await createNotification({
          user_id: updatedJob.created_by,
          company_id: req.user.companyId,
          type: 'job_completed',
          title: 'Job Completed',
          message: `${employeeName} completed the job: ${updatedJob.title}`,
          priority: 'medium',
          data: { job_id: updatedJob.id, employee_id: req.user.id }
        });
        console.log(`✅ Notified owner about job completion`);
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

/**
 * Accept a job (Employee only)
 */

module.exports = router;
