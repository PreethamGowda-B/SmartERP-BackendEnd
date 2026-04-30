/**
 * routes/customer/recurring.js
 *
 * Recurring job management for the Customer Portal.
 * Customers can create, list, and cancel recurring job templates.
 *
 * A recurring job template stores the job definition and recurrence pattern.
 * A background job (or startup check) creates actual job records when due.
 *
 * Endpoints:
 *   GET  /           — list customer's recurring templates
 *   POST /           — create a recurring template
 *   DELETE /:id      — cancel (deactivate) a recurring template
 *   POST /:id/run    — manually trigger one instance now
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');
const { pool }       = require('../../db');
const errorLogger    = require('../../utils/errorLogger');
const { dispatchJob } = require('../../services/smartDispatch');
const { createNotificationForOwners } = require('../../utils/notificationHelpers');

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data, error: null });
}
function fail(res, message, statusCode = 500) {
  return res.status(statusCode).json({ success: false, data: null, error: message });
}

// ─── Ensure recurring_jobs table exists (idempotent) ──────────────────────────
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring_jobs (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      company_id      TEXT NOT NULL,
      title           VARCHAR(255) NOT NULL,
      description     TEXT,
      priority        VARCHAR(50) DEFAULT 'medium',
      pattern         VARCHAR(20) NOT NULL,  -- 'daily' | 'weekly' | 'monthly'
      next_run_at     TIMESTAMP NOT NULL,
      end_date        TIMESTAMP,
      is_active       BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMP DEFAULT NOW(),
      last_run_at     TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_jobs_customer ON recurring_jobs(customer_id);
    CREATE INDEX IF NOT EXISTS idx_recurring_jobs_next_run ON recurring_jobs(next_run_at) WHERE is_active = TRUE;
  `).catch(() => {}); // Silently ignore if already exists
}

ensureTable();

// ─── GET / — list recurring templates ────────────────────────────────────────
router.get('/', async (req, res) => {
  const customerId = req.customer.id;
  const companyId  = req.customer.companyId;
  try {
    const result = await pool.query(
      `SELECT id, title, description, priority, pattern, next_run_at, end_date, is_active, created_at, last_run_at
       FROM recurring_jobs
       WHERE customer_id = $1 AND company_id = $2
       ORDER BY created_at DESC`,
      [customerId, companyId]
    );
    return ok(res, result.rows);
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customer/recurring.GET /' });
    return fail(res, 'Server error');
  }
});

// ─── POST / — create recurring template ──────────────────────────────────────
router.post('/', [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('pattern').isIn(['daily', 'weekly', 'monthly']).withMessage('Pattern must be daily, weekly, or monthly'),
  body('start_date').isISO8601().withMessage('Valid start_date required'),
  body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  body('end_date').optional({ checkFalsy: true }).isISO8601().withMessage('Invalid end_date'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 400);

  const customerId = req.customer.id;
  const companyId  = req.customer.companyId;
  const { title, description, priority = 'medium', pattern, start_date, end_date } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO recurring_jobs
         (customer_id, company_id, title, description, priority, pattern, next_run_at, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [customerId, companyId, title, description || null, priority, pattern, new Date(start_date), end_date ? new Date(end_date) : null]
    );
    return ok(res, result.rows[0], 201);
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customer/recurring.POST /' });
    return fail(res, 'Server error');
  }
});

// ─── DELETE /:id — cancel recurring template ─────────────────────────────────
router.delete('/:id', async (req, res) => {
  const customerId = req.customer.id;
  const companyId  = req.customer.companyId;
  const { id }     = req.params;
  try {
    const result = await pool.query(
      `UPDATE recurring_jobs SET is_active = FALSE
       WHERE id = $1 AND customer_id = $2 AND company_id = $3
       RETURNING id`,
      [id, customerId, companyId]
    );
    if (result.rowCount === 0) return fail(res, 'Recurring job not found', 404);
    return ok(res, { cancelled: true });
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customer/recurring.DELETE /:id' });
    return fail(res, 'Server error');
  }
});

// ─── POST /:id/run — manually trigger one instance ───────────────────────────
router.post('/:id/run', async (req, res) => {
  const customerId = req.customer.id;
  const companyId  = req.customer.companyId;
  const { id }     = req.params;
  try {
    const templateResult = await pool.query(
      `SELECT * FROM recurring_jobs WHERE id = $1 AND customer_id = $2 AND company_id = $3 AND is_active = TRUE`,
      [id, customerId, companyId]
    );
    if (templateResult.rows.length === 0) return fail(res, 'Recurring job not found', 404);
    const t = templateResult.rows[0];

    // Check auto_approve setting
    const settingResult = await pool.query(
      `SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = 'auto_approve_customer_jobs'`,
      [companyId]
    );
    const autoApprove = settingResult.rows[0]?.setting_value === 'true';
    const approvalStatus = autoApprove ? 'approved' : 'pending_approval';

    const approvedAt = autoApprove ? new Date() : null;

    const jobResult = await pool.query(
      `INSERT INTO jobs
         (title, description, priority, status, approval_status, approved_at,
          customer_id, company_id, source, visible_to_all, created_by, employee_status)
       VALUES ($1, $2, $3, 'open', $4, $5,
               $6, $7, 'customer', TRUE, NULL, 'assigned')
       RETURNING *`,
      [t.title, t.description, t.priority, approvalStatus, approvedAt, customerId, companyId]
    );
    const createdJob = jobResult.rows[0];

    // Update last_run_at and compute next_run_at
    const nextRun = computeNextRun(new Date(), t.pattern);
    await pool.query(
      `UPDATE recurring_jobs SET last_run_at = NOW(), next_run_at = $1 WHERE id = $2`,
      [nextRun, id]
    );

    // Notify owners
    createNotificationForOwners({
      company_id: companyId,
      type: 'job',
      title: 'New Recurring Customer Job',
      message: `Recurring job triggered: ${t.title}`,
      priority: t.priority,
      data: { job_id: createdJob.id, source: 'customer', approval_status: approvalStatus },
    }).catch(() => {});

    if (autoApprove) {
      const { createNotificationForCompany } = require('../../utils/notificationHelpers');
      createNotificationForCompany({
        company_id: companyId,
        type: 'job_available',
        title: 'New Job Available',
        message: 'A recurring job is available: "' + createdJob.title + '"',
        priority: t.priority,
        data: { job_id: createdJob.id, source: 'customer', url: '/employee/jobs' },
      }).catch(() => {});
    }

    return ok(res, { job: createdJob }, 201);
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customer/recurring.POST /:id/run' });
    return fail(res, 'Server error');
  }
});

function computeNextRun(from, pattern) {
  const d = new Date(from);
  if (pattern === 'daily')   d.setDate(d.getDate() + 1);
  if (pattern === 'weekly')  d.setDate(d.getDate() + 7);
  if (pattern === 'monthly') d.setMonth(d.getMonth() + 1);
  return d;
}

module.exports = router;
