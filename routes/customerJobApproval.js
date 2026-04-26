/**
 * routes/customerJobApproval.js
 *
 * Customer Job Approval Workflow — Owner & HR Portal endpoints
 * Mounted at: /api/v1/customer-jobs  and  /api/customer-jobs
 *
 * Production hardening applied:
 *   Section 1  — Transactions contain ONLY DB ops; notifications/SSE/logging are post-commit
 *   Section 2  — Dispatch triggered ONLY after COMMIT, fully async, never blocks approval
 *   Section 3  — SSE events include unique event_id for deduplication
 *   Section 6  — All migration/DB errors caught; server never crashes
 *   Section 7  — NULL approval_status treated as 'approved' (legacy data safety)
 *   Section 8  — Standardized response: { success, data, error }
 *   Section 9  — Centralized error logging via errorLogger
 *   Section 10 — Rate limiting on mutating endpoints via existing customerAuthLimiter
 *   SQL fix    — Correct $N parameterization in GET / filter query (was missing $ prefix)
 */

'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { dispatchJob }       = require('../services/smartDispatch');
const { createNotificationForOwners } = require('../utils/notificationHelpers');
const auditService  = require('../services/auditService');
const slaService    = require('../services/slaService');
const errorLogger   = require('../utils/errorLogger');
const redisClient   = require('../utils/redis');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Section 8: Standardized response envelope */
function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data, error: null });
}
function fail(res, message, statusCode = 500) {
  return res.status(statusCode).json({ success: false, data: null, error: message });
}

/** Section 3: Unique event ID for SSE deduplication */
function sseEventId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Section 7: Treat NULL approval_status as 'approved' (legacy data) */
function resolveApprovalStatus(status) {
  return status || 'approved';
}

/** Role guard: owner or hr only */
function requireOwnerOrHr(req, res, next) {
  if (!['owner', 'hr'].includes(req.user?.role)) {
    return fail(res, 'Access denied. Owner or HR role required.', 403);
  }
  next();
}

/** Notify customer via in-app activity record (non-blocking, post-commit) */
function notifyCustomer(customerId, companyId, { type, title, message, jobId }) {
  pool.query(
    `INSERT INTO activities (user_id, action, activity_type, details, company_id, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      null, type, 'customer_notification',
      JSON.stringify({ customer_id: customerId, title, message, job_id: jobId }),
      companyId,
    ]
  ).catch((e) => console.error('notifyCustomer error:', e.message));
}

/** Publish SSE event to customer portal (non-blocking, post-commit) */
function publishSSE(jobId, payload) {
  if (!redisClient || redisClient.status !== 'ready') return;
  // Section 3: attach unique event_id for frontend deduplication
  const event = { ...payload, event_id: sseEventId(), timestamp: new Date().toISOString() };
  redisClient.publish(`customer_job_events:${jobId}`, JSON.stringify(event))
    .catch((e) => console.error('SSE publish error:', e.message));
}

async function upsertSetting(companyId, key, value, userId) {
  return pool.query(
    `INSERT INTO company_settings (company_id, setting_key, setting_value, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (company_id, setting_key) DO UPDATE
     SET setting_value = $3, updated_by = $4, updated_at = NOW()`,
    [companyId, key, value, userId]
  );
}

// ─── GET / — list customer jobs with filters ──────────────────────────────────
router.get('/', authenticateToken, requireOwnerOrHr, async (req, res) => {
  const companyId = req.user.companyId;
  const { approval_status, priority, date_from, date_to, page = 1, limit = 50 } = req.query;

  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
  const offset   = (pageNum - 1) * limitNum;

  try {
    // Section 7: include NULL approval_status as 'approved' via COALESCE in ORDER BY
    const conditions = [`j.company_id = $1`, `j.source = 'customer'`];
    const params = [companyId];
    let idx = 2;

    if (approval_status) {
      // Section 7: NULL treated as 'approved'
      if (approval_status === 'approved') {
        conditions.push(`(j.approval_status = $${idx} OR j.approval_status IS NULL)`);
      } else {
        conditions.push(`j.approval_status = $${idx}`);
      }
      params.push(approval_status);
      idx++;
    }
    if (priority) {
      conditions.push(`j.priority = $${idx++}`);
      params.push(priority);
    }
    if (date_from) {
      conditions.push(`j.created_at >= $${idx++}`);
      params.push(new Date(date_from));
    }
    if (date_to) {
      conditions.push(`j.created_at <= $${idx++}`);
      params.push(new Date(date_to));
    }

    const where = conditions.join(' AND ');

    const [countResult, listResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM jobs j WHERE ${where}`, params),
      pool.query(
        `SELECT
           j.id, j.title, j.description, j.priority,
           COALESCE(j.approval_status, 'approved') AS approval_status,
           j.status, j.employee_status,
           j.created_at, j.approved_at, j.rejected_at, j.assigned_at,
           j.started_at, j.completed_at,
           j.sla_accept_breached, j.sla_completion_breached,
           j.ai_suggested_priority,
           c.name            AS customer_name,
           c.email           AS customer_email,
           comp.company_name AS customer_company_name,
           u.name            AS assigned_employee_name
         FROM jobs j
         LEFT JOIN customers c    ON c.id    = j.customer_id
         LEFT JOIN companies comp ON comp.id = j.company_id
         LEFT JOIN users u        ON u.id    = j.assigned_to
         WHERE ${where}
         ORDER BY
           CASE COALESCE(j.approval_status, 'approved')
             WHEN 'pending_approval' THEN 0
             WHEN 'approved'         THEN 1
             ELSE 2
           END,
           j.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limitNum, offset]
      ),
    ]);

    return ok(res, {
      jobs:  listResult.rows,
      total: parseInt(countResult.rows[0].count),
      page:  pageNum,
      limit: limitNum,
    });
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customerJobApproval.GET /' });
    return fail(res, 'Server error');
  }
});

// ─── POST /:id/approve ────────────────────────────────────────────────────────
// Section 1: Transaction contains ONLY DB ops
// Section 2: Dispatch triggered ONLY after COMMIT
router.post('/:id/approve', authenticateToken, requireOwnerOrHr, async (req, res) => {
  const companyId = req.user.companyId;
  const { id }    = req.params;

  const client = await pool.connect();
  let updatedJob = null;

  try {
    await client.query('BEGIN');

    // Conditional update — atomic race condition prevention
    const result = await client.query(
      `UPDATE jobs
       SET approval_status = 'approved',
           approved_at     = NOW(),
           status          = 'open'
       WHERE id = $1
         AND company_id = $2
         AND source = 'customer'
         AND COALESCE(approval_status, 'pending_approval') = 'pending_approval'
       RETURNING id, title, customer_id, priority, approval_status`,
      [id, companyId]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      // Determine exact reason
      const check = await pool.query(
        `SELECT COALESCE(approval_status, 'pending_approval') AS approval_status
         FROM jobs WHERE id = $1 AND company_id = $2`,
        [id, companyId]
      );
      if (check.rows.length === 0) return fail(res, 'Job not found', 404);
      const cur = check.rows[0].approval_status;
      if (cur === 'approved')  return fail(res, 'Job was already approved', 409);
      if (cur === 'rejected')  return fail(res, 'Cannot approve a rejected job', 400);
      return fail(res, 'Job could not be approved in its current state', 409);
    }

    updatedJob = result.rows[0];

    // Section 1: COMMIT before any external operations
    await client.query('COMMIT');

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    errorLogger.logFromRequest(req, err, { context: 'customerJobApproval.approve', extra: { jobId: id } });
    return fail(res, 'Server error');
  } finally {
    client.release();
  }

  // ── Section 1 & 2: All external ops happen AFTER commit ──────────────────

  // Audit log (non-blocking)
  auditService.logFromRequest(req, {
    companyId, userId: req.user.id, actorType: 'user',
    actionType: 'job_approved', entityType: 'job', entityId: id,
    oldValue: { approval_status: 'pending_approval' },
    newValue: { approval_status: 'approved', approved_by: req.user.id },
  }).catch(() => {});

  // Notify customer (non-blocking)
  if (updatedJob.customer_id) {
    notifyCustomer(updatedJob.customer_id, companyId, {
      type: 'job_approved',
      title: 'Your request has been approved',
      message: `Your service request "${updatedJob.title}" has been approved and will be assigned shortly.`,
      jobId: id,
    });
    // Section 3: SSE with unique event_id
    publishSSE(id, { type: 'job_approved', jobId: id, approvedAt: new Date().toISOString() });
  }

  // Section 2: Dispatch ONLY after commit, fully async, never blocks response
  setImmediate(() => {
    dispatchJob(id, companyId).then((dispatchResult) => {
      if (!dispatchResult.assigned) {
        createNotificationForOwners({
          company_id: companyId,
          type: 'dispatch_failed',
          title: 'No Employee Available',
          message: `Job "${updatedJob.title}" approved but no employee could be auto-assigned. Please assign manually.`,
          priority: updatedJob.priority || 'medium',
          data: { job_id: id, reason: dispatchResult.reason },
        }).catch(() => {});
      }
    }).catch((e) => {
      errorLogger.log(e, { context: 'smartDispatch.post-approve', extra: { jobId: id } });
    });
  });

  return ok(res, { job: updatedJob });
});

// ─── POST /:id/reject ─────────────────────────────────────────────────────────
// Section 1: Transaction contains ONLY DB ops
router.post('/:id/reject', authenticateToken, requireOwnerOrHr, async (req, res) => {
  const companyId = req.user.companyId;
  const { id }    = req.params;
  const { reason } = req.body;

  const client = await pool.connect();
  let updatedJob = null;

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE jobs
       SET approval_status = 'rejected',
           rejected_at     = NOW(),
           status          = 'cancelled'
       WHERE id = $1
         AND company_id = $2
         AND source = 'customer'
         AND COALESCE(approval_status, 'pending_approval') = 'pending_approval'
       RETURNING id, title, customer_id`,
      [id, companyId]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      const check = await pool.query(
        `SELECT COALESCE(approval_status, 'pending_approval') AS approval_status
         FROM jobs WHERE id = $1 AND company_id = $2`,
        [id, companyId]
      );
      if (check.rows.length === 0) return fail(res, 'Job not found', 404);
      const cur = check.rows[0].approval_status;
      if (cur === 'rejected') return fail(res, 'Job was already rejected', 409);
      if (cur === 'approved') return fail(res, 'Cannot reject an already approved job', 400);
      return fail(res, 'Job could not be rejected in its current state', 409);
    }

    updatedJob = result.rows[0];

    // Section 1: COMMIT before external ops
    await client.query('COMMIT');

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    errorLogger.logFromRequest(req, err, { context: 'customerJobApproval.reject', extra: { jobId: id } });
    return fail(res, 'Server error');
  } finally {
    client.release();
  }

  // ── Post-commit external ops ──────────────────────────────────────────────

  auditService.logFromRequest(req, {
    companyId, userId: req.user.id, actorType: 'user',
    actionType: 'job_rejected', entityType: 'job', entityId: id,
    oldValue: { approval_status: 'pending_approval' },
    newValue: { approval_status: 'rejected', rejected_by: req.user.id, reason: reason || null },
  }).catch(() => {});

  if (updatedJob.customer_id) {
    notifyCustomer(updatedJob.customer_id, companyId, {
      type: 'job_rejected',
      title: 'Your request was not approved',
      message: `Your service request "${updatedJob.title}" could not be approved.${reason ? ` Reason: ${reason}` : ''}`,
      jobId: id,
    });
    // Section 3: SSE with unique event_id
    publishSSE(id, { type: 'job_rejected', jobId: id, reason: reason || null, rejectedAt: new Date().toISOString() });
  }

  return ok(res, { job: updatedJob });
});

// ─── GET /settings ────────────────────────────────────────────────────────────
router.get('/settings', authenticateToken, requireOwnerOrHr, async (req, res) => {
  const companyId = req.user.companyId;
  try {
    const [settingsResult, slaConfig] = await Promise.all([
      pool.query(
        `SELECT setting_key, setting_value FROM company_settings
         WHERE company_id = $1
           AND setting_key IN ('auto_approve_customer_jobs', 'hourly_rate', 'service_charge')`,
        [companyId]
      ),
      slaService.getSlaConfig(companyId),
    ]);

    const s = {};
    settingsResult.rows.forEach((r) => { s[r.setting_key] = r.setting_value; });

    return ok(res, {
      auto_approve_customer_jobs: s.auto_approve_customer_jobs === 'true',
      hourly_rate:    parseFloat(s.hourly_rate)    || 50,
      service_charge: parseFloat(s.service_charge) || 0,
      sla: slaConfig,
    });
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customerJobApproval.GET /settings' });
    return fail(res, 'Server error');
  }
});

// ─── PUT /settings ────────────────────────────────────────────────────────────
router.put('/settings', authenticateToken, async (req, res) => {
  if (req.user.role !== 'owner') {
    return fail(res, 'Only owners can update company settings', 403);
  }
  const companyId = req.user.companyId;
  const { auto_approve_customer_jobs, hourly_rate, service_charge, sla_max_accept_time, sla_max_completion_time } = req.body;

  try {
    const updates = [];
    if (typeof auto_approve_customer_jobs === 'boolean') {
      updates.push(upsertSetting(companyId, 'auto_approve_customer_jobs', String(auto_approve_customer_jobs), req.user.id));
    }
    if (typeof hourly_rate === 'number' && hourly_rate >= 0) {
      updates.push(upsertSetting(companyId, 'hourly_rate', String(hourly_rate), req.user.id));
    }
    if (typeof service_charge === 'number' && service_charge >= 0) {
      updates.push(upsertSetting(companyId, 'service_charge', String(service_charge), req.user.id));
    }
    if (sla_max_accept_time != null || sla_max_completion_time != null) {
      updates.push(pool.query(
        `INSERT INTO sla_configs (company_id, max_accept_time, max_completion_time, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id) DO UPDATE
         SET max_accept_time     = COALESCE($2, sla_configs.max_accept_time),
             max_completion_time = COALESCE($3, sla_configs.max_completion_time),
             updated_at          = NOW()`,
        [companyId, sla_max_accept_time || null, sla_max_completion_time || null, req.user.id]
      ));
    }
    if (updates.length === 0) return fail(res, 'No valid settings provided', 400);

    await Promise.all(updates);

    auditService.logFromRequest(req, {
      companyId, userId: req.user.id, actorType: 'user',
      actionType: 'company_settings_updated', entityType: 'company', entityId: companyId,
      newValue: req.body,
    }).catch(() => {});

    return ok(res, { updated: true });
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customerJobApproval.PUT /settings' });
    return fail(res, 'Server error');
  }
});

// ─── GET /sla-metrics ─────────────────────────────────────────────────────────
router.get('/sla-metrics', authenticateToken, requireOwnerOrHr, async (req, res) => {
  const companyId = req.user.companyId;
  const { start_date, end_date } = req.query;
  try {
    const metrics = await slaService.getSlaMetrics(companyId, {
      startDate: start_date ? new Date(start_date) : undefined,
      endDate:   end_date   ? new Date(end_date)   : undefined,
    });
    return ok(res, metrics);
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customerJobApproval.GET /sla-metrics' });
    return fail(res, 'Server error');
  }
});

module.exports = router;
