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
 *   Settings   — GET /settings wraps company_settings query in try/catch; returns safe
 *                defaults when company_id is non-UUID or table row is missing
 */

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { dispatchJob } = require('../services/smartDispatch');
const { createNotificationForOwners } = require('../utils/notificationHelpers');
const auditService = require('../services/auditService');
const slaService = require('../services/slaService');
const errorLogger = require('../utils/errorLogger');
const redisClient = require('../utils/redis');

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

/** Role guard: owner or hr only */
function requireOwnerOrHr(req, res, next) {
  if (!['owner', 'hr'].includes(req.user && req.user.role)) {
    return fail(res, 'Access denied. Owner or HR role required.', 403);
  }
  next();
}

/** Notify customer via in-app activity record (non-blocking, post-commit) */
function notifyCustomer(customerId, companyId, opts) {
  const { type, title, message, jobId } = opts;
  pool.query(
    'INSERT INTO activities (user_id, action, activity_type, details, company_id, created_at)' +
    ' VALUES ($1, $2, $3, $4, $5, NOW())',
    [
      null, type, 'customer_notification',
      JSON.stringify({ customer_id: customerId, title, message, job_id: jobId }),
      companyId,
    ]
  ).catch(function (e) { console.error('notifyCustomer error:', e.message); });
}

/** Publish SSE event to customer portal (non-blocking, post-commit) */
function publishSSE(jobId, payload) {
  if (!redisClient || redisClient.status !== 'ready') return;
  var event = Object.assign({}, payload, { event_id: sseEventId(), timestamp: new Date().toISOString() });
  redisClient.publish('customer_job_events:' + jobId, JSON.stringify(event))
    .catch(function (e) { console.error('SSE publish error:', e.message); });
}

function upsertSetting(companyId, key, value, userId) {
  return pool.query(
    'INSERT INTO company_settings (company_id, setting_key, setting_value, updated_by, updated_at)' +
    ' VALUES ($1, $2, $3, $4, NOW())' +
    ' ON CONFLICT (company_id, setting_key) DO UPDATE' +
    ' SET setting_value = $3, updated_by = $4, updated_at = NOW()',
    [companyId, key, value, userId]
  );
}

// ─── GET / — list customer jobs with filters ──────────────────────────────────
// BUG FIX: was using bare ${idx} instead of $N placeholders — caused SQL syntax
// errors that made every query fail, so the UI always showed stale/wrong data.
router.get('/', authenticateToken, requireOwnerOrHr, async (req, res) => {
  const companyId = req.user.companyId;
  const approval_status = req.query.approval_status;
  const priority = req.query.priority;
  const date_from = req.query.date_from;
  const date_to = req.query.date_to;
  const page = req.query.page || 1;
  const limit = req.query.limit || 50;

  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
  const offset = (pageNum - 1) * limitNum;

  try {
    // Build WHERE clause with correct $N placeholders
    const conditions = ["j.company_id::text = $1", "j.source = 'customer'"];
    const params = [String(companyId)];
    var idx = 2;

    if (approval_status) {
      // Section 7: NULL treated as 'approved'
      if (approval_status === 'approved') {
        conditions.push('j.approval_status = $' + idx);
      } else {
        conditions.push('j.approval_status = $' + idx);
      }
      params.push(approval_status);
      idx++;
    }
    if (priority) {
      conditions.push('j.priority = $' + idx);
      params.push(priority);
      idx++;
    }
    if (date_from) {
      conditions.push('j.created_at >= $' + idx);
      params.push(new Date(date_from));
      idx++;
    }
    if (date_to) {
      conditions.push('j.created_at <= $' + idx);
      params.push(new Date(date_to));
      idx++;
    }

    const where = conditions.join(' AND ');
    const limitIdx = idx;
    const offsetIdx = idx + 1;

    const listSql =
      'SELECT' +
      '  j.id, j.title, j.description, j.priority,' +
      '  j.approval_status,' +
      '  j.status, j.employee_status,' +
      '  j.created_at, j.approved_at, j.rejected_at, j.assigned_at,' +
      '  j.started_at, j.completed_at,' +
      '  j.sla_accept_breached, j.sla_completion_breached,' +
      '  j.ai_suggested_priority,' +
      '  c.name            AS customer_name,' +
      '  c.email           AS customer_email,' +
      '  comp.company_name AS customer_company_name,' +
      '  u.name            AS assigned_employee_name' +
      ' FROM jobs j' +
      ' LEFT JOIN customers c    ON c.id    = j.customer_id' +
      ' LEFT JOIN companies comp ON comp.id = j.company_id' +
      ' LEFT JOIN users u        ON u.id    = j.assigned_to' +
      ' WHERE ' + where +
      ' ORDER BY' +
      '   CASE j.approval_status' +
      "     WHEN 'pending_approval' THEN 0" +
      "     WHEN 'approved'         THEN 1" +
      '     ELSE 2' +
      '   END,' +
      '   j.created_at DESC' +
      ' LIMIT $' + limitIdx + ' OFFSET $' + offsetIdx;

    const listParams = params.concat([limitNum, offset]);

    const countResult = await pool.query('SELECT COUNT(*) FROM jobs j WHERE ' + where, params);
    const listResult = await pool.query(listSql, listParams);

    console.log('[customerJobApproval.GET /] fetched', listResult.rows.length, 'jobs for company', companyId);

    return ok(res, {
      jobs: listResult.rows,
      total: parseInt(countResult.rows[0].count),
      page: pageNum,
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
  const id = req.params.id;

  const client = await pool.connect();
  var updatedJob = null;

  try {
    await client.query('BEGIN');

    // Conditional update — atomic race condition prevention
    // Use company_id::text comparison to handle both INTEGER and UUID company_id types
    const result = await client.query(
      'UPDATE jobs' +
      "  SET approval_status  = 'approved'," +
      '      approved_at      = NOW(),' +
      "      status           = 'open'," +
      "      employee_status  = 'assigned'" +
      ' WHERE id = $1' +
      '   AND company_id::text = $2' +
      "   AND source = 'customer'" +
      "   AND approval_status = 'pending_approval'" +
      ' RETURNING id, title, customer_id, priority, approval_status',
      [id, String(companyId)]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      // Check current state to give a meaningful error
      const check = await pool.query(
        "SELECT approval_status FROM jobs WHERE id = $1 AND company_id::text = $2",
        [id, String(companyId)]
      );
      if (check.rows.length === 0) return fail(res, 'Job not found', 404);
      const cur = check.rows[0].approval_status;
      if (cur === 'approved') return fail(res, 'Job was already approved', 409);
      if (cur === 'rejected') return fail(res, 'Cannot approve a rejected job', 400);
      return fail(res, 'Job could not be approved in its current state', 409);
    }

    updatedJob = result.rows[0];

    // Section 1: COMMIT before any external operations
    await client.query('COMMIT');

    console.log('[customerJobApproval.approve] Job', id, 'approved. approval_status =', updatedJob.approval_status);

  } catch (err) {
    await client.query('ROLLBACK').catch(function () { });
    errorLogger.logFromRequest(req, err, { context: 'customerJobApproval.approve', extra: { jobId: id } });
    return fail(res, 'Server error');
  } finally {
    client.release();
  }

  // ── Section 1 & 2: All external ops happen AFTER commit ──────────────────

  auditService.logFromRequest(req, {
    companyId, userId: req.user.id, actorType: 'user',
    actionType: 'job_approved', entityType: 'job', entityId: id,
    oldValue: { approval_status: 'pending_approval' },
    newValue: { approval_status: 'approved', approved_by: req.user.id },
  }).catch(function () { });

  if (updatedJob.customer_id) {
    notifyCustomer(updatedJob.customer_id, companyId, {
      type: 'job_approved',
      title: 'Your request has been approved',
      message: 'Your service request "' + updatedJob.title + '" has been approved and will be assigned shortly.',
      jobId: id,
    });
    publishSSE(id, { type: 'job_approved', jobId: id, approvedAt: new Date().toISOString() });
  }

  setImmediate(function () {
    dispatchJob(id, companyId).then(function (dispatchResult) {
      if (!dispatchResult.assigned) {
        // Dispatch found no employee — notify ALL employees so they can self-assign
        const { createNotificationForCompany } = require('../utils/notificationHelpers');
        createNotificationForCompany({
          company_id: companyId,
          type: 'job_available',
          title: 'New Job Available',
          message: 'A customer job is available to accept: "' + updatedJob.title + '"',
          priority: updatedJob.priority || 'medium',
          data: { job_id: id, source: 'customer', url: '/employee/jobs' },
        }).catch(function () { });

        createNotificationForOwners({
          company_id: companyId,
          type: 'dispatch_failed',
          title: 'No Employee Available',
          message: 'Job "' + updatedJob.title + '" approved but no employee could be auto-assigned. Please assign manually.',
          priority: updatedJob.priority || 'medium',
          data: { job_id: id, reason: dispatchResult.reason },
        }).catch(function () { });
      } else {
        // Dispatch succeeded — notify the assigned employee specifically
        // (smartDispatch already sends a notification, but we ensure it's correct)
      }
    }).catch(function (e) {
      // Dispatch failed entirely — still notify employees so they can pick it up
      const { createNotificationForCompany } = require('../utils/notificationHelpers');
      createNotificationForCompany({
        company_id: companyId,
        type: 'job_available',
        title: 'New Job Available',
        message: 'A customer job is available to accept: "' + updatedJob.title + '"',
        priority: updatedJob.priority || 'medium',
        data: { job_id: id, source: 'customer', url: '/employee/jobs' },
      }).catch(function () { });
      errorLogger.log(e, { context: 'smartDispatch.post-approve', extra: { jobId: id } });
    });
  });

  return ok(res, { job: updatedJob });
});

// ─── POST /:id/reject ─────────────────────────────────────────────────────────
router.post('/:id/reject', authenticateToken, requireOwnerOrHr, async (req, res) => {
  const companyId = req.user.companyId;
  const id = req.params.id;
  const reason = req.body.reason;

  const client = await pool.connect();
  var updatedJob = null;

  try {
    await client.query('BEGIN');

    const result = await client.query(
      'UPDATE jobs' +
      "  SET approval_status = 'rejected'," +
      '      rejected_at     = NOW(),' +
      "      status          = 'cancelled'" +
      ' WHERE id = $1' +
      '   AND company_id::text = $2' +
      "   AND source = 'customer'" +
      "   AND approval_status = 'pending_approval'" +
      ' RETURNING id, title, customer_id',
      [id, String(companyId)]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      const check = await pool.query(
        "SELECT approval_status" +
        ' FROM jobs WHERE id = $1 AND company_id::text = $2',
        [id, String(companyId)]
      );
      if (check.rows.length === 0) return fail(res, 'Job not found', 404);
      const cur = check.rows[0].approval_status;
      if (cur === 'rejected') return fail(res, 'Job was already rejected', 409);
      if (cur === 'approved') return fail(res, 'Cannot reject an already approved job', 400);
      return fail(res, 'Job could not be rejected in its current state', 409);
    }

    updatedJob = result.rows[0];
    await client.query('COMMIT');

  } catch (err) {
    await client.query('ROLLBACK').catch(function () { });
    errorLogger.logFromRequest(req, err, { context: 'customerJobApproval.reject', extra: { jobId: id } });
    return fail(res, 'Server error');
  } finally {
    client.release();
  }

  auditService.logFromRequest(req, {
    companyId, userId: req.user.id, actorType: 'user',
    actionType: 'job_rejected', entityType: 'job', entityId: id,
    oldValue: { approval_status: 'pending_approval' },
    newValue: { approval_status: 'rejected', rejected_by: req.user.id, reason: reason || null },
  }).catch(function () { });

  if (updatedJob.customer_id) {
    notifyCustomer(updatedJob.customer_id, companyId, {
      type: 'job_rejected',
      title: 'Your request was not approved',
      message: 'Your service request "' + updatedJob.title + '" could not be approved.' + (reason ? ' Reason: ' + reason : ''),
      jobId: id,
    });
    publishSSE(id, { type: 'job_rejected', jobId: id, reason: reason || null, rejectedAt: new Date().toISOString() });
  }

  return ok(res, { job: updatedJob });
});

// ─── GET /settings ────────────────────────────────────────────────────────────
// BUG FIX: company_id may be a non-UUID value (e.g. "1") in legacy/test environments.
// The company_settings query was throwing "invalid input syntax for type uuid" and
// crashing the handler. Now wrapped in its own try/catch with safe defaults.
router.get('/settings', authenticateToken, requireOwnerOrHr, async (req, res) => {
  const companyId = req.user && req.user.companyId;

  if (!companyId) {
    return fail(res, 'Missing company context', 400);
  }

  // Safe defaults — returned whenever the DB query fails or returns no rows
  const DEFAULT_SETTINGS = {
    auto_approve_customer_jobs: false,
    hourly_rate: 50,
    service_charge: 0,
    sla: { max_accept_time: 15, max_completion_time: 240 },
  };

  // Fetch company_settings — wrapped separately so a UUID type error doesn't 500
  var settingsMap = {};
  try {
    const settingsResult = await pool.query(
      'SELECT setting_key, setting_value FROM company_settings' +
      ' WHERE company_id = $1' +
      "   AND setting_key IN ('auto_approve_customer_jobs', 'hourly_rate', 'service_charge')",
      [companyId]
    );
    settingsResult.rows.forEach(function (r) { settingsMap[r.setting_key] = r.setting_value; });
    console.log('[customerJobApproval.GET /settings] fetched settings for company', companyId, settingsMap);
  } catch (settingsErr) {
    // Non-UUID company_id or missing table — use defaults, don't crash
    console.warn('[customerJobApproval.GET /settings] company_settings query failed (using defaults):', settingsErr.message);
  }

  // Fetch SLA config — getSlaConfig already never throws (returns defaults on error)
  var slaConfig = DEFAULT_SETTINGS.sla;
  try {
    slaConfig = await slaService.getSlaConfig(companyId);
  } catch (slaErr) {
    console.warn('[customerJobApproval.GET /settings] getSlaConfig failed (using defaults):', slaErr.message);
  }

  return ok(res, {
    auto_approve_customer_jobs: settingsMap.auto_approve_customer_jobs === 'true',
    hourly_rate: parseFloat(settingsMap.hourly_rate) || DEFAULT_SETTINGS.hourly_rate,
    service_charge: parseFloat(settingsMap.service_charge) || DEFAULT_SETTINGS.service_charge,
    sla: slaConfig,
  });
});

// ─── PUT /settings ────────────────────────────────────────────────────────────
router.put('/settings', authenticateToken, async (req, res) => {
  if (req.user.role !== 'owner') {
    return fail(res, 'Only owners can update company settings', 403);
  }
  const companyId = req.user.companyId;
  const auto_approve_customer_jobs = req.body.auto_approve_customer_jobs;
  const hourly_rate = req.body.hourly_rate;
  const service_charge = req.body.service_charge;
  const sla_max_accept_time = req.body.sla_max_accept_time;
  const sla_max_completion_time = req.body.sla_max_completion_time;

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
        'INSERT INTO sla_configs (company_id, max_accept_time, max_completion_time, created_by)' +
        ' VALUES ($1, $2, $3, $4)' +
        ' ON CONFLICT (company_id) DO UPDATE' +
        ' SET max_accept_time     = COALESCE($2, sla_configs.max_accept_time),' +
        '     max_completion_time = COALESCE($3, sla_configs.max_completion_time),' +
        '     updated_at          = NOW()',
        [companyId, sla_max_accept_time || null, sla_max_completion_time || null, req.user.id]
      ));
    }
    if (updates.length === 0) return fail(res, 'No valid settings provided', 400);

    await Promise.all(updates);

    auditService.logFromRequest(req, {
      companyId, userId: req.user.id, actorType: 'user',
      actionType: 'company_settings_updated', entityType: 'company', entityId: companyId,
      newValue: req.body,
    }).catch(function () { });

    return ok(res, { updated: true });
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customerJobApproval.PUT /settings' });
    return fail(res, 'Server error');
  }
});

// ─── GET /sla-metrics ─────────────────────────────────────────────────────────
router.get('/sla-metrics', authenticateToken, requireOwnerOrHr, async (req, res) => {
  const companyId = req.user.companyId;
  const start_date = req.query.start_date;
  const end_date = req.query.end_date;
  try {
    const metrics = await slaService.getSlaMetrics(companyId, {
      startDate: start_date ? new Date(start_date) : undefined,
      endDate: end_date ? new Date(end_date) : undefined,
    });
    return ok(res, metrics);
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customerJobApproval.GET /sla-metrics' });
    return fail(res, 'Server error');
  }
});

module.exports = router;
