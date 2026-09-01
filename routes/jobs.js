const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification, createNotificationForCompany, createNotificationForOwners } = require('../utils/notificationHelpers');
const { sendJobAssignedEmail, sendJobCompletedEmail } = require('../services/emailNotificationService');
const { body, validationResult } = require('express-validator');
const { logJobAudit } = require('../utils/auditLogger');
const { validateStateTransition, JOB_STATES } = require('../utils/jobStateMachine');
const { requireClockIn } = require('../middleware/attendanceGatekeeperMiddleware');

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


const { loadPlan, checkPlanLimit } = require('../middleware/planMiddleware');
const EventMessagingService = require('../services/eventMessagingService');

/**
 * Create a new job
 */
router.post('/', authenticateToken, loadPlan, checkPlanLimit('job'), [
  body('title').trim().notEmpty().withMessage('Title is required').escape(),
  body('description').optional({ checkFalsy: true }).trim().escape(),
  body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage('Invalid priority value'),
  body('status').optional().isIn(['open', 'pending', 'in_progress', 'active', 'completed', 'closed', 'cancelled']).withMessage('Invalid status value')
], async (req, res) => {
  // 🛡️ H-3 Fix: Restrict job creation to owner / super_admin role server-side
  if (req.user.role !== 'owner' && req.user.role !== 'super_admin') {
    return res.status(403).json({ 
      message: "Access Denied: Only company owners or platform administrators can create jobs directly." 
    });
  }

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

  const visibleToAll = job.visible_to_all !== undefined
    ? job.visible_to_all === true || job.visible_to_all === 'true'
    : (assignedTo ? false : true);

  try {
    const ownerId = req.user.role === 'owner' ? req.user.id : null;
    const initialState = assignedTo ? 'assigned' : 'open';

    const result = await pool.query(
      `INSERT INTO jobs 
       (title, description, assigned_to, assigned_employee_id, owner_id, created_by, company_id, data, visible_to_all, status, priority, employee_status, state)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, 'assigned', $11)
       RETURNING *`,
      [
        title,
        description,
        assignedTo,
        ownerId,
        req.user.id,
        req.user.companyId || null,
        job,
        visibleToAll,
        job.status || 'open',
        job.priority || 'medium',
        initialState,
      ]
    );

    const createdJob = result.rows[0];

    // Audit Log
    logJobAudit({
      companyId: req.user.companyId,
      jobId: createdJob.id,
      userId: req.user.id,
      userRole: req.user.role,
      action: 'JOB_CREATED',
      newState: initialState,
      newValue: { title, assignedTo, priority: job.priority || 'medium' },
      ipAddress: req.ip,
    });

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
        // 📧 Email: Notify assigned employee asynchronously (non-blocking)
        setImmediate(async () => {
          try {
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
          } catch (e) {
            console.warn('⚠️ Async job assigned email warning:', e.message);
          }
        });
      }
    } catch (notifErr) {
      console.error('❌ Failed to send job notification:', notifErr);
    }

    // Auto-spawn job conversation thread (Enterprise Communication Backbone)
    EventMessagingService.onJobCreated({
      jobId: createdJob.id,
      companyId: req.user.companyId,
      title,
      customerId: createdJob.customer_id || null,
      ownerId: req.user.id,
      assignedEmployeeId: assignedTo || null,
    }).catch(() => { }); // non-blocking, never breaks response

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
    const userRole = (req.user.role || 'employee').toLowerCase();
    const companyId = req.user.companyId || req.user.company_id;

    if (!companyId && userRole !== 'super_admin') {
      return res.json({
        jobs: [],
        total: 0,
        page,
        limit,
        pages: 0
      });
    }

    if (userRole === 'owner' || userRole === 'admin' || userRole === 'super_admin') {
      // Exclude pending_approval / rejected customer jobs from the owner/admin tasks list
      const ownerWhere = `
        j.company_id::text = $1
        AND (j.source IS NULL OR j.source != 'customer' OR j.approval_status = 'approved')
      `;
      countResult = await pool.query(`SELECT COUNT(DISTINCT j.id) FROM jobs j WHERE ${ownerWhere}`, [String(companyId)]);
      result = await pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (j.id) j.*, u.email as employee_email, u.name as employee_name,
                  inv.id AS invoice_id, inv.invoice_number, inv.status AS invoice_status,
                  inv.viewed_at AS invoice_viewed_at, inv.downloaded_at AS invoice_downloaded_at,
                  inv.total_amount AS invoice_total_amount,
                  inv.version_number AS invoice_version_number,
                  inv.edited_count AS invoice_edited_count
           FROM jobs j
           LEFT JOIN users u ON COALESCE(j.assigned_to, j.assigned_employee_id, j.accepted_by)::text = u.id::text
           LEFT JOIN invoices inv ON inv.job_id::text = j.id::text
           WHERE ${ownerWhere}
           ORDER BY j.id
         ) sub
         ORDER BY sub.created_at DESC
         LIMIT $2 OFFSET $3`,
        [String(companyId), limit, offset]
      );
    } else if (userRole === 'employee') {
      // 🛡️ H-2 Fix: Employees strictly only see jobs where:
      //   1. visible_to_all = true (broadcast to all employees)
      //   2. assigned_to = this employee (directly assigned)
      //   3. created_by = this employee
      // Exclude cancelled jobs unless assigned to this employee.
      const userId = String(req.user.id || req.user.userId || '');
      const empWhere = `
        j.company_id::text = $1
        AND (
          j.visible_to_all = true
          OR j.assigned_to::text = $2
          OR j.created_by::text = $2
        )
        AND (j.source IS NULL OR j.source != 'customer' OR j.approval_status = 'approved')
        AND (j.status NOT IN ('cancelled') OR j.assigned_to::text = $2)
      `;
      countResult = await pool.query(
        `SELECT COUNT(DISTINCT j.id) FROM jobs j WHERE ${empWhere}`,
        [String(companyId), userId]
      );
      result = await pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (j.id) j.*, u.name as assigned_employee_name,
                  inv.id AS invoice_id, inv.invoice_number, inv.status AS invoice_status,
                  NULL AS invoice_total_amount,
                  inv.version_number AS invoice_version_number,
                  inv.edited_count AS invoice_edited_count
           FROM jobs j
           LEFT JOIN users u ON j.assigned_to = u.id
           LEFT JOIN invoices inv ON inv.job_id::text = j.id::text
           WHERE ${empWhere}
           ORDER BY j.id
         ) sub
         ORDER BY sub.created_at DESC
         LIMIT $3 OFFSET $4`,
        [String(companyId), userId, limit, offset]
      );
    } else {
      // HR/other staff: see all approved company jobs
      const staffWhere = `
        j.company_id::text = $1
        AND (j.source IS NULL OR j.source != 'customer' OR j.approval_status = 'approved')
      `;
      countResult = await pool.query(`SELECT COUNT(DISTINCT j.id) FROM jobs j WHERE ${staffWhere}`, [String(companyId)]);
      result = await pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (j.id) j.*, u.email as employee_email, u.name as employee_name,
                  inv.id AS invoice_id, inv.invoice_number, inv.status AS invoice_status,
                  inv.viewed_at AS invoice_viewed_at, inv.downloaded_at AS invoice_downloaded_at,
                  inv.total_amount AS invoice_total_amount
           FROM jobs j 
           LEFT JOIN users u ON j.assigned_to = u.id
           LEFT JOIN invoices inv ON inv.job_id::text = j.id::text
           WHERE ${staffWhere}
           ORDER BY j.id
         ) sub
         ORDER BY sub.created_at DESC 
         LIMIT $2 OFFSET $3`,
        [String(companyId), limit, offset]
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
        employee_name: r.employee_name ?? r.assigned_employee_name ?? null,
        accepted_by_name: r.accepted_by_name ?? r.employee_name ?? r.assigned_employee_name ?? null,
        assigned_employee_name: r.assigned_employee_name ?? r.employee_name ?? null,
        accepted_by: r.accepted_by ?? r.assigned_to ?? null,
        is_customer_job: r.source === 'customer' || r.source === 'customer_portal' || r.created_by_role === 'customer' || Boolean(r.customer_id),
        approval_status: r.approval_status ?? null,
        customer_id: r.customer_id ?? null,
        company_id: r.company_id ?? null,
        started_at: r.started_at ?? null,
        assigned_employee_name: r.assigned_employee_name ?? null,
        invoice_id: r.invoice_id ?? null,
        invoice_number: r.invoice_number ?? null,
        invoice_status: r.invoice_status ?? null,
        invoice_viewed_at: r.invoice_viewed_at ?? null,
        invoice_downloaded_at: r.invoice_downloaded_at ?? null,
        invoice_total_amount: r.invoice_total_amount ?? null,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error('jobs GET error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/jobs/:id ────────────────────────────────────────────────────────
// Retrieve details for a specific single job by ID
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Skip if it's a known sub-route (e.g. actions, approvals, invoices, etc.)
    const staticRoutes = ['chat-unread-count', 'invoices', 'approvals', 'action-requests'];
    if (staticRoutes.includes(id)) {
      return next();
    }

    const userRole = (req.user.role || 'employee').toLowerCase();
    const companyId = req.user.companyId || req.user.company_id;
    const userId = String(req.user.id || req.user.userId || '');

    const result = await pool.query(
      `SELECT j.*, u.email as employee_email, u.name as employee_name,
              inv.id AS invoice_id, inv.invoice_number, inv.status AS invoice_status,
              inv.viewed_at AS invoice_viewed_at, inv.downloaded_at AS invoice_downloaded_at,
              inv.total_amount AS invoice_total_amount,
              inv.version_number AS invoice_version_number,
              inv.edited_count AS invoice_edited_count
       FROM jobs j
       LEFT JOIN users u ON COALESCE(j.assigned_to, j.assigned_employee_id, j.accepted_by)::text = u.id::text
       LEFT JOIN invoices inv ON inv.job_id::text = j.id::text
       WHERE j.id::text = $1
       LIMIT 1`,
      [String(id)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Job not found' });
    }

    const r = result.rows[0];

    // Verify tenant isolation (super_admin can view all)
    if (userRole !== 'super_admin' && String(r.company_id) !== String(companyId)) {
      return res.status(403).json({ message: 'Access denied: Job belongs to another company' });
    }

    // Verify employee RBAC permissions
    if (userRole === 'employee') {
      const isVisible = r.visible_to_all === true ||
                        String(r.assigned_to) === userId ||
                        String(r.created_by) === userId;
      if (!isVisible) {
        return res.status(403).json({ message: 'Access denied: You are not assigned to this job' });
      }
    }

    const job = r.data && typeof r.data === 'object' ? r.data : {};
    const formattedJob = {
      ...job,
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
      employee_name: r.employee_name ?? r.assigned_employee_name ?? null,
      accepted_by_name: r.accepted_by_name ?? r.employee_name ?? r.assigned_employee_name ?? null,
      assigned_employee_name: r.assigned_employee_name ?? r.employee_name ?? null,
      accepted_by: r.accepted_by ?? r.assigned_to ?? null,
      is_customer_job: r.source === 'customer' || r.source === 'customer_portal' || r.created_by_role === 'customer' || Boolean(r.customer_id),
      approval_status: r.approval_status ?? null,
      customer_id: r.customer_id ?? null,
      company_id: r.company_id ?? null,
      started_at: r.started_at ?? null,
      invoice_id: r.invoice_id ?? null,
      invoice_number: r.invoice_number ?? null,
      invoice_status: r.invoice_status ?? null,
      invoice_viewed_at: r.invoice_viewed_at ?? null,
      invoice_downloaded_at: r.invoice_downloaded_at ?? null,
      invoice_total_amount: r.invoice_total_amount ?? null,
    };

    res.json({ ok: true, job: formattedJob, ...formattedJob });
  } catch (err) {
    console.error('GET /api/jobs/:id error:', err);
    res.status(500).json({ message: 'Server error retrieving job details' });
  }
});

/**
 * Accept a job (Employee only)
 * Section 1: wrapped in DB transaction — accept + started_at + active_job_count are atomic
 */
const handleJobAccept = async (req, res) => {
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

    const result = await client.query(
      `UPDATE jobs
        SET employee_status = 'accepted',
            accepted_at     = NOW(),
            started_at      = NOW(),
            status          = 'in_progress',
            state           = 'accepted',
            assigned_to     = $2,
            assigned_employee_id = $2,
            accepted_by     = $2,
            current_worker_id = $2,
            visible_to_all  = false,
            approval_status = CASE
              WHEN source = 'customer' AND COALESCE(approval_status, 'pending_approval') = 'pending_approval'
              THEN 'approved'
              ELSE COALESCE(approval_status, 'approved')
            END,
            approved_at = CASE
              WHEN source = 'customer' AND COALESCE(approval_status, 'pending_approval') = 'pending_approval'
              THEN NOW()
              ELSE approved_at
            END
        WHERE id = $1
          AND company_id::text = $3
          AND (assigned_to IS NULL OR assigned_to = $2)
          AND (employee_status IN ('assigned', 'pending') OR employee_status IS NULL)
        RETURNING *`,
      [id, req.user.id, String(req.user.companyId)]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      const current = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
      const cur = current.rows[0];

      console.warn(`[jobs/accept] UPDATE returned 0 rows for job ${id}. ` +
        `employee_status=${cur?.employee_status}, assigned_to=${cur?.assigned_to}, ` +
        `status=${cur?.status}, company_id=${cur?.company_id}, requester=${req.user.id}`);

      if (cur && cur.employee_status === 'accepted' && String(cur.assigned_to) === String(req.user.id)) {
        return res.status(200).json(cur);
      }
      if (cur && cur.employee_status === 'accepted' && cur.assigned_to && String(cur.assigned_to) !== String(req.user.id)) {
        return res.status(409).json({ message: 'Job already accepted by another employee' });
      }
      if (cur && ['completed', 'cancelled'].includes(cur.status)) {
        return res.status(409).json({ message: `Job is already ${cur.status}` });
      }
      return res.status(409).json({ message: 'Job is no longer available for acceptance' });
    }

    const acceptedJob = result.rows[0];

    await client.query('COMMIT');

    logJobAudit({
      companyId: req.user.companyId || acceptedJob.company_id,
      jobId: acceptedJob.id,
      userId: req.user.id,
      userRole: req.user.role,
      action: 'JOB_ACCEPTED',
      oldState: 'assigned',
      newState: 'accepted',
      ipAddress: req.ip,
    });

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
      console.error('❌ Failed to send job acceptance notification:', notifErr.message);
    }

    if (acceptedJob?.machine_id) {
      await client.query(
        `INSERT INTO machine_timeline_events (company_id, machine_id, job_id, event_type, title, description, created_at)
         VALUES ($1, $2, $3, 'engineer_assigned', 'Engineer Assigned & Accepted', $4, NOW())`,
        [req.user.companyId || 1, acceptedJob.machine_id, acceptedJob.id, `Engineer ${req.user.name || 'Technician'} accepted job ${acceptedJob.title}`]
      ).catch(() => { });
    }

    res.json(acceptedJob);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { });
      console.error('jobs ACCEPT error', err);
      res.status(500).json({ message: 'Server error' });
    } finally {
      client.release();
    }
  };

  router.post('/:id/accept', authenticateToken, requireClockIn, handleJobAccept);
  router.put('/:id/accept', authenticateToken, requireClockIn, handleJobAccept);
  router.patch('/:id/accept', authenticateToken, requireClockIn, handleJobAccept);

  /**
   * Decline a job (Employee only)
   */
  const handleJobDecline = async (req, res) => {
    const { id } = req.params;

    try {
      const checkJob = await pool.query(
        'SELECT * FROM jobs WHERE id = $1 AND (assigned_to = $2 OR visible_to_all = true) AND company_id::text = $3',
        [id, req.user.id, String(req.user.companyId)]
      );

      if (checkJob.rows.length === 0) {
        return res.status(403).json({ message: 'Job not assigned to you' });
      }

      const result = await pool.query(
        `UPDATE jobs
       SET employee_status = 'declined',
           declined_at     = NOW()
       WHERE id = $1
         AND company_id::text = $2
         AND (employee_status IN ('assigned', 'pending') OR employee_status IS NULL)
       RETURNING *`,
        [id, String(req.user.companyId)]
      );

      if (result.rowCount === 0) {
        return res.status(409).json({ message: 'Job not available for decline (already accepted or wrong company)' });
      }

      const declinedJob = result.rows[0];

      try {
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
  };

  router.post('/:id/decline', authenticateToken, requireClockIn, handleJobDecline);
  router.put('/:id/decline', authenticateToken, requireClockIn, handleJobDecline);
  router.patch('/:id/decline', authenticateToken, requireClockIn, handleJobDecline);

  /**
   * Update job progress (Employee only — Accepted Technician)
   */
  const handleJobProgress = async (req, res) => {
    const { id } = req.params;
    const { progress } = req.body;

    if (req.user.role === 'owner') {
      return res.status(403).json({
        message: 'Owners are supervisors and cannot directly alter field progress. Use Owner Emergency Override if necessary.'
      });
    }

    if (typeof progress !== 'number' || progress < 0 || progress > 100) {
      return res.status(400).json({ message: 'Progress must be between 0 and 100' });
    }

    try {
      console.log(`🔍 Checking job access: JobID=${id}, UserID=${req.user.id}`);

      const jobExists = await pool.query(
        `SELECT id, assigned_to, accepted_by, employee_status, state, progress FROM jobs j
       WHERE j.id = $1
         AND (j.company_id::text = $2 OR j.company_id::text IN (SELECT c.id::text FROM companies c WHERE c.id::text = $2 OR c.company_id::text = $2))`,
        [id, String(req.user.companyId)]
      );
      if (jobExists.rows.length === 0) {
        return res.status(404).json({ message: 'Job not found' });
      }

      const curJob = jobExists.rows[0];
      const isAcceptedTechnician =
        (curJob.accepted_by && String(curJob.accepted_by) === String(req.user.id)) ||
        (curJob.assigned_to && String(curJob.assigned_to) === String(req.user.id) && curJob.employee_status === 'accepted');

      if (!isAcceptedTechnician) {
        console.warn(`⛔ Access denied for Job ${id} by User ${req.user.id} (Not accepted technician)`);
        return res.status(403).json({
          message: 'Only the technician who accepted this job can update field progress.'
        });
      }

      let status = 'in_progress';
      let newState = 'in_progress';
      let completed_at = null;

      if (progress === 100) {
        status = 'completed';
        newState = 'completed';
        completed_at = new Date();
      }

      const result = await pool.query(
        `UPDATE jobs
       SET progress            = $1,
           status              = $2,
           state               = $3,
           completed_at        = $4,
           completed_by        = CASE WHEN $1 = 100 THEN $5 ELSE completed_by END,
           employee_status     = CASE WHEN $1 = 100 THEN 'completed' ELSE employee_status END,
           current_worker_id   = $5,
           approval_status     = CASE
             WHEN $1 = 100 AND source = 'customer' AND approval_status = 'pending_approval'
             THEN 'approved'
             ELSE approval_status
           END,
           approved_at = CASE
             WHEN $1 = 100 AND source = 'customer' AND approval_status = 'pending_approval'
             THEN NOW()
             ELSE approved_at
           END
       WHERE id = $6
         AND company_id::text = $7
       RETURNING *`,
        [progress, status, newState, completed_at, req.user.id, id, String(req.user.companyId)]
      );

      if (result.rowCount === 0) {
        return res.status(403).json({ message: 'Cannot update job — access denied or already completed' });
      }

      const updatedJob = result.rows[0];

      logJobAudit({
        companyId: req.user.companyId,
        jobId: updatedJob.id,
        userId: req.user.id,
        userRole: req.user.role,
        action: progress === 100 ? 'JOB_COMPLETED' : 'PROGRESS_UPDATED',
        oldState: curJob.state,
        newState: newState,
        oldValue: { progress: curJob.progress },
        newValue: { progress: updatedJob.progress },
        ipAddress: req.ip,
      });

      if (progress === 100) {
        pool.query(
          `UPDATE employee_profiles
         SET active_job_count = GREATEST(0, COALESCE(active_job_count, 0) - 1)
         WHERE user_id = $1`,
          [req.user.id]
        ).catch(e => console.error('active_job_count decrement error:', e.message));

        const { generateInvoice } = require('../services/billingService');
        generateInvoice(updatedJob.id, updatedJob.company_id || req.user.companyId)
          .catch(e => console.error('Invoice generation error:', e.message));
      }

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
  };

  router.post('/:id/progress', authenticateToken, requireClockIn, handleJobProgress);
  router.put('/:id/progress', authenticateToken, requireClockIn, handleJobProgress);
  router.patch('/:id/progress', authenticateToken, requireClockIn, handleJobProgress);

  /**
   * Update job (Owner/Admin only)
   */
  router.put('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const updates = req.body || {};
    const companyId = req.user.companyId;

    // Only owners and admins can update jobs
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only owners can update jobs' });
    }

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
   * Delete job (Owner/Admin only)
   */
  router.delete('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const companyId = req.user.companyId;

    // Only owners and admins can delete jobs
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only owners can delete jobs' });
    }

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
   * GET /jobs/chat-unread-count — Employee gets total unread messages across all jobs
   * NOTE: GET/POST /:id/messages were removed (duplicates of /api/messages/job/:jobId).
   * The canonical chat routes live in routes/messages.js.
   */
  router.get('/chat-unread-count', authenticateToken, async (req, res) => {
    const employeeId = req.user.id;
    try {
      const result = await pool.query(
        `SELECT COUNT(*) as count
       FROM job_messages jm
       INNER JOIN jobs j ON j.id = jm.job_id
       WHERE j.assigned_to = $1
         AND jm.sender_type = 'customer'
         AND jm.read_by_employee = FALSE`,
        [employeeId]
      );
      res.json({ count: parseInt(result.rows[0].count) });
    } catch (err) {
      console.error('chat unread count error:', err.message);
      res.json({ count: 0 });
    }
  });

  // ─── POST /api/jobs/:id/invoice ─────────────────────────────────────────────
  // Generate invoice for completed job
  router.post('/:id/invoice', authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const userCompanyId = req.user.companyId;

      // Fetch job record
      const jobRes = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
      if (jobRes.rows.length === 0) {
        return res.status(404).json({ message: 'Job not found' });
      }

      const job = jobRes.rows[0];

      // STRICT VERIFICATION REQUIREMENT:
      // Verify job's company_id matches requesting user's company_id AND job status is 'completed'
      if (String(job.company_id) !== String(userCompanyId)) {
        return res.status(400).json({ message: 'Company mismatch: Job does not belong to your company' });
      }

      if (job.status !== 'completed') {
        return res.status(400).json({ message: 'Invalid status: Invoices can only be generated for completed jobs' });
      }

      const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
      const amount = parseFloat(job.amount || job.total_amount || 1500);

      // Cloudinary upload for invoice PDF
      let pdfUrl = null;
      const { cloudinary, hasCloudinaryConfig } = require('../config/cloudinary');
      const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'dvqnrmdbo';
      if (hasCloudinaryConfig) {
        try {
          const invoiceContent = `Invoice #${invoiceNumber} for Job ${job.title} - Total: ₹${amount}`;
          const uploadResult = await cloudinary.uploader.upload(`data:text/plain;base64,${Buffer.from(invoiceContent).toString('base64')}`, {
            folder: `smarterp/invoices/${userCompanyId}`,
            public_id: `invoice_${invoiceNumber}`,
            resource_type: 'raw'
          });
          pdfUrl = uploadResult.secure_url;
        } catch (cloudErr) {
          console.warn('⚠️ Cloudinary invoice upload warning:', cloudErr.message);
          pdfUrl = `https://res.cloudinary.com/${cloudName}/raw/upload/v${Date.now()}/smarterp/invoices/${userCompanyId}/invoice_${invoiceNumber}.pdf`;
        }
      } else {
        pdfUrl = `https://res.cloudinary.com/${cloudName}/raw/upload/v${Date.now()}/smarterp/invoices/${userCompanyId}/invoice_${invoiceNumber}.pdf`;
      }

      await pool.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_url TEXT;').catch(() => { });

      const invRes = await pool.query(
        `INSERT INTO invoices 
       (job_id, company_id, customer_id, invoice_number, total_amount, status, pdf_url, generated_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'generated', $6, NOW(), NOW())
       RETURNING *`,
        [job.id, String(userCompanyId), job.customer_id || null, invoiceNumber, amount, pdfUrl]
      );

      // Post invoice ERP card to job conversation thread (Enterprise Communication Backbone)
      EventMessagingService.onInvoiceIssued({
        jobId: job.id,
        companyId: userCompanyId,
        invoiceNumber,
        totalAmount: amount,
        senderId: req.user.id,
      }).catch(() => { }); // non-blocking

      // Notify Customer in real-time if job has a customer_id
      if (job.customer_id) {
        createNotification({
          user_id: job.customer_id,
          company_id: userCompanyId,
          type: 'invoice_generated',
          title: 'New Invoice Issued',
          message: `Invoice #${invoiceNumber} for ₹${Number(amount).toLocaleString('en-IN')} has been generated.`,
          priority: 'high',
          actor_id: req.user.id,
          data: { invoice_id: invRes.rows[0].id, job_id: job.id, url: '/customer/invoices' }
        }).catch(() => { });
      }

      res.status(201).json({
        success: true,
        message: 'Invoice generated successfully',
        invoice: invRes.rows[0]
      });
    } catch (err) {
      console.error('❌ Error generating job invoice:', err);
      res.status(500).json({ message: 'Server error generating invoice' });
    }
  });

  // ─── GET /api/jobs/invoices/all ──────────────────────────────────────────────
  // List company job invoices (Owner Billing tab & Customer view)
  router.get('/invoices/all', authenticateToken, async (req, res) => {
    try {
      const userCompanyId = req.user.companyId;
      await pool.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_url TEXT;').catch(() => { });

      const result = await pool.query(
        `SELECT i.*, j.title as job_title, COALESCE(i.customer_name, c.name, 'Customer') as customer_name 
       FROM invoices i
       LEFT JOIN jobs j ON i.job_id = j.id
       LEFT JOIN customers c ON j.customer_id = c.id
       WHERE i.company_id = $1
       ORDER BY i.generated_at DESC`,
        [String(userCompanyId)]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching job invoices:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // ─── POST /api/jobs/:id/actions ─────────────────────────────────────────────
  // Submit a field job action (status, assistance, material, expense, evidence, safety)
  router.post('/:id/actions', authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const userCompanyId = String(req.user.companyId);
      const userId = req.user.id;

      const { module, action_type, urgency = 'normal', notes, evidence_urls = [], payload = {} } = req.body;

      if (!module || !action_type) {
        return res.status(400).json({ message: 'Module and action_type are required' });
      }

      const jobCheck = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
      if (jobCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Job not found' });
      }
      const job = jobCheck.rows[0];

      if (String(job.company_id) !== userCompanyId) {
        return res.status(403).json({ message: 'Access denied: Job belongs to another company' });
      }

      const requiresApproval = ['assistance', 'expense', 'safety', 'material'].includes(module) || urgency === 'emergency' || urgency === 'high';
      const status = requiresApproval ? 'pending_approval' : 'completed';

      const actionRes = await pool.query(
        `INSERT INTO job_actions 
       (job_id, company_id, performed_by, module, action_type, urgency, requires_approval, status, notes, evidence_urls, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
       RETURNING *`,
        [job.id, userCompanyId, userId, module, action_type, urgency, requiresApproval, status, notes || null, JSON.stringify(evidence_urls), JSON.stringify(payload)]
      );

      const actionRecord = actionRes.rows[0];

      // Log Activity Timeline entry
      await pool.query(
        `INSERT INTO activities (user_id, company_id, action, activity_type, details, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
        [userId, userCompanyId, `Job Action: ${action_type}`, `job_${module}`, JSON.stringify({ job_id: job.id, action_id: actionRecord.id, action_type, urgency })]
      ).catch(() => { });

      // Notify Owners if approval required or high urgency/emergency
      if (requiresApproval || urgency === 'emergency') {
        const ownersRes = await pool.query("SELECT id FROM users WHERE company_id = $1 AND role IN ('owner', 'admin')", [userCompanyId]);
        const title = urgency === 'emergency' ? `🚨 EMERGENCY ALERT on Job: ${job.title}` : `Field Action Request: ${action_type.replace(/_/g, ' ')}`;
        const message = `${req.user.name || 'Technician'} reported: ${notes || action_type.replace(/_/g, ' ')}`;

        for (const owner of ownersRes.rows) {
          await createNotification({
            user_id: owner.id,
            company_id: userCompanyId,
            type: urgency === 'emergency' ? 'emergency_alert' : 'field_action_request',
            title,
            message,
            priority: urgency === 'emergency' ? 'urgent' : 'high',
            data: { job_id: job.id, action_id: actionRecord.id, module, action_type }
          }).catch(() => { });
        }
      }

      res.status(201).json({
        success: true,
        message: 'Job action submitted successfully',
        action: actionRecord
      });
    } catch (err) {
      console.error('❌ Error submitting job action:', err);
      res.status(500).json({ message: 'Server error submitting job action' });
    }
  });

  // ─── GET /api/jobs/:id/actions ──────────────────────────────────────────────
  // Fetch action history for a specific job
  router.get('/:id/actions', authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const userCompanyId = String(req.user.companyId);

      const result = await pool.query(
        `SELECT ja.*, u.name as performer_name, r.name as resolver_name
       FROM job_actions ja
       LEFT JOIN users u ON ja.performed_by = u.id
       LEFT JOIN users r ON ja.resolved_by = r.id
       WHERE ja.job_id = $1 AND ja.company_id = $2
       ORDER BY ja.created_at DESC`,
        [id, userCompanyId]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching job actions:', err);
      res.status(500).json({ message: 'Server error fetching job actions' });
    }
  });

  // ─── GET /api/admin/approvals/field-actions ──────────────────────────────────
  // Fetch all pending field actions across company for Owner Approval Center
  router.get('/approvals/field-actions', authenticateToken, async (req, res) => {
    try {
      const userCompanyId = String(req.user.companyId);
      const result = await pool.query(
        `SELECT ja.*, j.title as job_title, u.name as requester_name
       FROM job_actions ja
       LEFT JOIN jobs j ON ja.job_id = j.id
       LEFT JOIN users u ON ja.performed_by = u.id
       WHERE ja.company_id = $1 AND ja.status = 'pending_approval'
       ORDER BY ja.created_at DESC`,
        [userCompanyId]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching pending field actions:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // ─── PATCH /api/jobs/actions/:actionId/respond ──────────────────────────────
  // Owner approval/rejection decision endpoint
  router.patch('/actions/:actionId/respond', authenticateToken, async (req, res) => {
    try {
      const { actionId } = req.params;
      const { decision, owner_response } = req.body; // 'approved' or 'rejected'
      const userCompanyId = String(req.user.companyId);
      const resolverId = req.user.id;

      if (!['approved', 'rejected'].includes(decision)) {
        return res.status(400).json({ message: 'Decision must be approved or rejected' });
      }

      const actionRes = await pool.query('SELECT * FROM job_actions WHERE id = $1 AND company_id = $2', [actionId, userCompanyId]);
      if (actionRes.rows.length === 0) {
        return res.status(404).json({ message: 'Job action not found' });
      }
      const action = actionRes.rows[0];

      const updated = await pool.query(
        `UPDATE job_actions 
       SET status = $1, owner_response = $2, resolved_by = $3, resolved_at = NOW(), updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
        [decision, owner_response || null, resolverId, actionId]
      );

      // Notify requesting employee
      await createNotification({
        user_id: action.performed_by,
        company_id: userCompanyId,
        type: 'field_action_response',
        title: `Field Request ${decision === 'approved' ? 'Approved ✅' : 'Rejected ❌'}`,
        message: `Your request (${action.action_type.replace(/_/g, ' ')}) was ${decision}${owner_response ? `: ${owner_response}` : '.'}`,
        priority: 'high',
        data: { job_id: action.job_id, action_id: actionId, decision }
      }).catch(() => { });

      res.json({
        success: true,
        message: `Field action ${decision}`,
        action: updated.rows[0]
      });
    } catch (err) {
      console.error('Error responding to job action:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  /**
   * POST /api/jobs/:jobId/actions
   * Employee submits field action request (Need More Workers, Equipment Needed, Safety Hazard, etc.)
   */
  router.post('/:jobId/actions', authenticateToken, async (req, res) => {
    try {
      const { jobId } = req.params;
      const companyId = req.user.companyId || req.user.company_id;
      const userId = req.user.id || req.user.userId;
      const userName = req.user.name || 'Employee';

      const { module, action_type, urgency, notes, evidence_urls, payload } = req.body;

      const jobRes = await pool.query('SELECT title FROM jobs WHERE id = $1', [jobId]);
      const jobTitle = jobRes.rows[0]?.title || 'Job';

      const result = await pool.query(
        `INSERT INTO job_action_requests
       (company_id, job_id, employee_id, employee_name, module, action_type, urgency, notes, evidence_urls, payload, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW(), NOW())
       RETURNING *`,
        [companyId, jobId, userId, userName, module || 'field', action_type || 'general_request', urgency || 'normal', notes || '', JSON.stringify(evidence_urls || []), JSON.stringify(payload || {})]
      );

      const actionReq = result.rows[0];

      // Notify Owner
      await createNotificationForOwners({
        company_id: companyId,
        type: 'job_action_request',
        title: urgency === 'emergency' ? '🚨 EMERGENCY SOS ALERT' : `Work Request: ${action_type.replace(/_/g, ' ')}`,
        message: `${userName} submitted a work request for "${jobTitle}": ${notes || action_type}`,
        priority: urgency === 'emergency' ? 'urgent' : 'high',
        data: { job_id: jobId, action_request_id: actionReq.id, url: '/owner/jobs' }
      }).catch(() => { });

      res.json({ success: true, request: actionReq });
    } catch (err) {
      console.error('POST /api/jobs/:jobId/actions error:', err);
      res.status(500).json({ message: err.message || 'Server error' });
    }
  });

  /**
   * GET /api/jobs/action-requests
   * Owner lists all employee field action requests
   */
  router.get('/action-requests', authenticateToken, async (req, res) => {
    try {
      const companyId = req.user.companyId || req.user.company_id;
      const { status, jobId } = req.query;

      let query = `
      SELECT r.*, j.title AS job_title, j.location AS job_location
      FROM job_action_requests r
      LEFT JOIN jobs j ON r.job_id = j.id
      WHERE r.company_id = $1
    `;
      const params = [companyId];

      if (status && status !== 'all') {
        params.push(status);
        query += ` AND r.status = $${params.length}`;
      }
      if (jobId) {
        params.push(jobId);
        query += ` AND r.job_id = $${params.length}`;
      }

      query += ` ORDER BY r.created_at DESC`;

      const result = await pool.query(query, params);
      res.json({ success: true, requests: result.rows });
    } catch (err) {
      console.error('GET /api/jobs/action-requests error:', err);
      res.status(500).json({ message: err.message || 'Server error' });
    }
  });

  /**
   * PATCH /api/jobs/action-requests/:requestId
   * Owner responds to (approves, rejects, resolves) employee work request
   */
  router.patch('/action-requests/:requestId', authenticateToken, async (req, res) => {
    try {
      const { requestId } = req.params;
      const companyId = req.user.companyId || req.user.company_id;
      const { status, owner_response } = req.body;

      const result = await pool.query(
        `UPDATE job_action_requests
       SET status = $1, owner_response = $2, resolved_at = CASE WHEN $1 IN ('approved', 'rejected', 'resolved') THEN NOW() ELSE resolved_at END, updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
        [status || 'resolved', owner_response || '', requestId, companyId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: 'Request not found' });
      }

      const updatedReq = result.rows[0];

      // Notify Employee
      if (updatedReq.employee_id) {
        await createNotification({
          user_id: updatedReq.employee_id,
          company_id: companyId,
          type: 'action_request_response',
          title: `Work Request ${status === 'approved' ? 'Approved ✅' : status === 'rejected' ? 'Rejected ❌' : 'Updated 💬'}`,
          message: `Your request (${updatedReq.action_type.replace(/_/g, ' ')}) was ${status}${owner_response ? `: ${owner_response}` : '.'}`,
          priority: 'high',
          data: { job_id: updatedReq.job_id, request_id: requestId, status }
        }).catch(() => { });
      }

      res.json({ success: true, request: updatedReq });
    } catch (err) {
      console.error('PATCH /api/jobs/action-requests/:requestId error:', err);
      res.status(500).json({ message: err.message || 'Server error' });
    }
  });

  /**
   * POST /api/jobs/:id/reassign (Owner Only)
   * Reassign job to a different field technician
   */
  router.post('/:id/reassign', authenticateToken, async (req, res) => {
    try {
      if (req.user.role !== 'owner') {
        return res.status(403).json({ message: 'Only company owners can reassign jobs.' });
      }

      const { id } = req.params;
      const { new_employee_id, reason } = req.body;

      if (!new_employee_id) {
        return res.status(400).json({ message: 'new_employee_id is required for job reassignment.' });
      }

      const companyId = req.user.companyId || req.user.company_id;

      // Fetch existing job
      const curRes = await pool.query(
        `SELECT * FROM jobs WHERE id = $1 AND company_id::text = $2`,
        [id, String(companyId)]
      );
      if (curRes.rows.length === 0) {
        return res.status(404).json({ message: 'Job not found' });
      }
      const curJob = curRes.rows[0];
      const prevEmployeeId = curJob.assigned_to;

      const result = await pool.query(
        `UPDATE jobs
       SET assigned_to          = $1,
           assigned_employee_id = $1,
           employee_status      = 'assigned',
           state                = 'assigned',
           accepted_by          = NULL,
           current_worker_id    = NULL,
           accepted_at          = NULL,
           is_override          = TRUE,
           override_reason      = $2,
           override_by          = $3,
           override_at          = NOW()
       WHERE id = $4 AND company_id::text = $5
       RETURNING *`,
        [new_employee_id, reason || 'Reassigned by Owner', req.user.id, id, String(companyId)]
      );

      const updatedJob = result.rows[0];

      // Audit Log
      logJobAudit({
        companyId,
        jobId: id,
        userId: req.user.id,
        userRole: req.user.role,
        action: 'JOB_REASSIGNED',
        oldState: curJob.state,
        newState: 'assigned',
        oldValue: { assignedTo: prevEmployeeId },
        newValue: { assignedTo: new_employee_id },
        reason: reason || 'Reassigned by Owner',
        ipAddress: req.ip,
      });

      // Notifications
      try {
        if (prevEmployeeId) {
          await createNotification({
            user_id: prevEmployeeId,
            company_id: companyId,
            type: 'job_reassigned',
            title: 'Job Reassigned',
            message: `Job "${curJob.title}" has been reassigned by the owner.`,
            priority: 'medium',
            data: { job_id: id }
          });
        }
        await createNotification({
          user_id: new_employee_id,
          company_id: companyId,
          type: 'job_assigned',
          title: 'New Job Assigned',
          message: `You have been assigned a new job: "${curJob.title}"`,
          priority: 'high',
          data: { job_id: id }
        });
      } catch (nErr) {
        console.error('Reassign notification error:', nErr.message);
      }

      res.json({ success: true, job: updatedJob });
    } catch (err) {
      console.error('POST /api/jobs/:id/reassign error:', err);
      res.status(500).json({ message: err.message || 'Server error' });
    }
  });

  /**
   * POST /api/jobs/:id/override (Owner Only — Emergency Override)
   * Supervisory override when assigned technician is unavailable
   */
  router.post('/:id/override', authenticateToken, async (req, res) => {
    try {
      if (req.user.role !== 'owner') {
        return res.status(403).json({ message: 'Only company owners can execute emergency overrides.' });
      }

      const { id } = req.params;
      const { action_type, reason, new_progress, new_employee_id } = req.body;

      if (!reason || typeof reason !== 'string' || !reason.trim()) {
        return res.status(400).json({ message: 'Compulsory override reason is required.' });
      }

      const companyId = req.user.companyId || req.user.company_id;

      const curRes = await pool.query(
        `SELECT * FROM jobs WHERE id = $1 AND company_id::text = $2`,
        [id, String(companyId)]
      );
      if (curRes.rows.length === 0) {
        return res.status(404).json({ message: 'Job not found' });
      }
      const curJob = curRes.rows[0];

      let newStatus = curJob.status;
      let newState = curJob.state;
      let newProgress = curJob.progress;
      let newAssignedTo = curJob.assigned_to;

      if (action_type === 'force_complete') {
        newStatus = 'completed';
        newState = 'completed';
        newProgress = 100;
      } else if (action_type === 'return_to_assigned') {
        newStatus = 'open';
        newState = 'assigned';
      } else if (action_type === 'cancel_job') {
        newStatus = 'cancelled';
        newState = 'cancelled';
      } else if (action_type === 'reassign' && new_employee_id) {
        newAssignedTo = new_employee_id;
        newState = 'assigned';
      } else if (action_type === 'override_progress' && typeof new_progress === 'number') {
        newProgress = Math.min(100, Math.max(0, new_progress));
        if (newProgress === 100) {
          newStatus = 'completed';
          newState = 'completed';
        }
      }

      const result = await pool.query(
        `UPDATE jobs
       SET status               = $1,
           state                = $2,
           progress             = $3,
           assigned_to          = $4,
           assigned_employee_id = $4,
           is_override          = TRUE,
           override_reason      = $5,
           override_by          = $6,
           override_at          = NOW(),
           completed_at         = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END,
           completed_by         = CASE WHEN $1 = 'completed' THEN $6 ELSE completed_by END
       WHERE id = $7 AND company_id::text = $8
       RETURNING *`,
        [newStatus, newState, newProgress, newAssignedTo, reason.trim(), req.user.id, id, String(companyId)]
      );

      const updatedJob = result.rows[0];

      // Log Audit Trail
      logJobAudit({
        companyId,
        jobId: id,
        userId: req.user.id,
        userRole: req.user.role,
        action: 'EMERGENCY_OVERRIDE',
        oldState: curJob.state,
        newState,
        oldValue: { status: curJob.status, progress: curJob.progress, assignedTo: curJob.assigned_to },
        newValue: { status: newStatus, progress: newProgress, assignedTo: newAssignedTo },
        reason: reason.trim(),
        metadata: { action_type },
        ipAddress: req.ip,
      });

      res.json({ success: true, job: updatedJob, message: `Emergency override executed successfully (${action_type}).` });
    } catch (err) {
      console.error('POST /api/jobs/:id/override error:', err);
      res.status(500).json({ message: err.message || 'Server error' });
    }
  });

  module.exports = router;

