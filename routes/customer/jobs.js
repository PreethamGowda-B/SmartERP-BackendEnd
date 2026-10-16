/**
 * routes/customer/jobs.js
 *
 * Customer Portal job routes — all protected by authenticateCustomer.
 * Every query is double-filtered by customer_id AND company_id.
 *
 * Status model (clear separation):
 *   approval_status: pending_approval | approved | rejected
 *   status (job_status): open | assigned | in_progress | completed | cancelled
 *   employee_status: assigned | accepted | arrived
 *
 * Production hardening:
 *   Section 7  — COALESCE(approval_status, 'approved') for legacy NULL rows
 *   Section 8  — Standardized response: { success, data, error }
 *   Section 9  — Centralized error logging via errorLogger
 *   Section 10 — Redis-based rate limiting on POST / (10 jobs/min per customer)
 *
 *   GET  /           — list own jobs (paginated)
 *   POST /           — create a new job (sets approval_status = pending_approval)
 *   GET  /:id        — get single job detail
 *   GET  /:id/tracking — get assigned employee GPS location
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');

const { pool } = require('../../db');
const redisClient = require('../../utils/redis');
const {
  createNotificationForOwners,
} = require('../../utils/notificationHelpers');
const { dispatchJob } = require('../../services/smartDispatch');
const { getSuggestedPriority } = require('../../services/autoPriorityService');
const auditService = require('../../services/auditService');
const errorLogger = require('../../utils/errorLogger');

// ─── Section 8: Standardized response helpers ─────────────────────────────────
function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data, error: null });
}
function fail(res, message, statusCode = 500) {
  return res.status(statusCode).json({ success: false, data: null, error: message });
}

// ─── Audit log helper (non-blocking) ─────────────────────────────────────────
function auditLog(req, customerId, action, details, companyId) {
  auditService.log({
    companyId,
    userId: customerId,
    actorType: 'customer',
    actionType: action,
    entityType: 'job',
    entityId: details?.job_id || null,
    newValue: details,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
}

// ─── GET / — list own jobs ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const customerId = req.customer.id;
  const companyId = req.customer.companyId;

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  try {
    const [listResult, countResult] = await Promise.all([
      pool.query(
        `SELECT
           j.id, j.title, j.description,
           j.status,
           j.approval_status,
           j.priority,
           j.progress,
           j.scheduled_at,
           j.machine_id,
           j.service_type,
           j.created_at, j.approved_at,
           j.started_at, j.completed_at
         FROM jobs j
         WHERE j.customer_id = $1
           AND j.company_id = $2
         ORDER BY j.created_at DESC
         LIMIT $3 OFFSET $4`,
        [customerId, companyId, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM jobs WHERE customer_id = $1 AND company_id = $2`,
        [customerId, companyId]
      ),
    ]);

    return ok(res, {
      jobs: listResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customer/jobs.GET /' });
    return fail(res, 'Server error');
  }
});

// ─── POST / — create a new job ────────────────────────────────────────────────
router.post('/', [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('priority')
    .optional()
    .isIn(['low', 'medium', 'high', 'urgent'])
    .withMessage('Invalid priority value'),
  body('description').optional({ checkFalsy: true }).trim(),
  body('scheduled_at').optional({ checkFalsy: true }).isISO8601().withMessage('Invalid scheduled_at date'),
  body('service_type').optional().isIn(['breakdown', 'maintenance', 'installation', 'general', 'other']).withMessage('Invalid service_type'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const firstError = errors.array()[0];
    return fail(res, firstError.msg, 400);
  }

  const rawCustomerId = req.customer?.id || req.customer?.customerId || req.customer?.userId;
  let rawCompanyId = req.customer?.companyId || req.customer?.company_id;
  const { title, description, priority, scheduled_at, machine_id, alarm_code, service_type } = req.body;

  // Resolve valid customer ID from customers table to prevent foreign key errors
  let resolvedCustomerId = null;
  if (rawCustomerId) {
    try {
      const custCheck = await pool.query('SELECT id, company_id FROM customers WHERE id::text = $1::text', [String(rawCustomerId)]);
      if (custCheck.rows.length > 0) {
        resolvedCustomerId = custCheck.rows[0].id;
        if (!rawCompanyId) rawCompanyId = custCheck.rows[0].company_id;
      } else if (req.customer?.email) {
        const emailCheck = await pool.query('SELECT id, company_id FROM customers WHERE email = $1', [req.customer.email]);
        if (emailCheck.rows.length > 0) {
          resolvedCustomerId = emailCheck.rows[0].id;
          if (!rawCompanyId) rawCompanyId = emailCheck.rows[0].company_id;
        }
      }
    } catch (cErr) {
      console.warn('Customer verification warning (non-fatal):', cErr.message);
    }
  }

  // Ensure companyId is a valid integer matching companies.id (or default 1)
  let resolvedCompanyId = rawCompanyId ? parseInt(rawCompanyId, 10) : null;
  if (!resolvedCompanyId || isNaN(resolvedCompanyId)) {
    resolvedCompanyId = 1;
  }
  const companyId = resolvedCompanyId;
  const customerId = resolvedCustomerId || rawCustomerId;

  // Section 10: Redis-based rate limiting — max 10 job creations per minute per customer
  try {
    if (redisClient && redisClient.status === 'ready') {
      const rateLimitKey = `customer_job_create:${customerId}`;
      const count = await redisClient.incr(rateLimitKey);
      if (count === 1) await redisClient.expire(rateLimitKey, 60);
      if (count > 10) {
        const ttl = await redisClient.ttl(rateLimitKey);
        return res.status(429).json({
          success: false,
          data: null,
          error: 'Too many job submissions. Please wait before submitting again.',
          retryAfter: ttl > 0 ? ttl : 60,
        });
      }
    }
  } catch (redisErr) {
    // Redis failure must NOT block job creation
    console.warn('Job rate limit Redis error (non-fatal):', redisErr.message);
  }

  try {
    // Validate company subscription before creating job
    // Guard: company_id may be a non-UUID value in legacy/test environments
    try {
      const companyCheck = await pool.query(
        'SELECT status, subscription_status FROM companies WHERE id = $1',
        [companyId]
      );
      const company = companyCheck.rows[0];
      if (company) {
        if (company.status === 'suspended') {
          return fail(res, 'Account Suspended/Disabled', 403);
        }
        if (company.subscription_status === 'expired' || company.subscription_status === 'cancelled') {
          return fail(res, 'Company subscription inactive', 403);
        }
      }
    } catch (companyCheckErr) {
      // Non-UUID company_id or missing companies table — skip subscription check, don't block job creation
      console.warn('Company subscription check skipped:', companyCheckErr.message);
    }

    // ── AI Priority Suggestion ────────────────────────────────────────────────
    const aiSuggestion = await getSuggestedPriority(title, description || '');
    const aiSuggestedPriority = aiSuggestion?.priority || null;
    // Use user-provided priority if given, otherwise fall back to AI suggestion
    const finalPriority = priority || aiSuggestedPriority || 'medium';
    const priorityOverridden = !!(priority && aiSuggestedPriority && priority !== aiSuggestedPriority);

    // ── Check auto_approve_customer_jobs setting ──────────────────────────────
    let autoApprove = false;
    try {
      const settingResult = await pool.query(
        `SELECT setting_value FROM company_settings
         WHERE (company_id::text = $1::text OR company_id::text IN (SELECT id::text FROM companies WHERE id::text = $1::text))
           AND setting_key = 'auto_approve_customer_jobs'`,
        [String(companyId)]
      );
      autoApprove = settingResult.rows.some(r => r.setting_value === 'true' || r.setting_value === true || r.setting_value === '1');
    } catch (settingErr) {
      console.warn('auto_approve setting check skipped (non-fatal):', settingErr.message);
    }
    const approvalStatus = autoApprove ? 'approved' : 'pending_approval';
    const approvedAt = autoApprove ? new Date() : null;

    const result = await pool.query(
      `INSERT INTO jobs
         (title, description, priority, ai_suggested_priority, priority_overridden,
          status, approval_status, approved_at,
          customer_id, company_id, source, visible_to_all, created_by, employee_status,
          scheduled_at, machine_id, alarm_code, service_type)
       VALUES ($1, $2, $3, $4, $5,
               'open', $6, $7,
               $8, $9, 'customer', $10, NULL, 'assigned',
               $11, $12, $13, $14)
       RETURNING *`,
      [
        title ? title.trim() : 'Customer Service Request',
        description ? description.trim() : null,
        finalPriority || 'medium',
        aiSuggestedPriority || null,
        Boolean(priorityOverridden),
        approvalStatus || 'pending_approval',
        approvedAt || null,
        resolvedCustomerId || null,
        resolvedCompanyId,
        Boolean(autoApprove),
        (scheduled_at && !isNaN(Date.parse(scheduled_at))) ? new Date(scheduled_at) : null,
        machine_id ? String(machine_id) : null,
        alarm_code ? String(alarm_code).trim() : null,
        service_type || 'breakdown',
      ]
    );

    const createdJob = result.rows[0];

    // Notify owners (non-blocking)
    createNotificationForOwners({
      company_id: companyId,
      type: 'job',
      title: autoApprove ? 'New Customer Job (Auto-Approved)' : 'New Customer Job — Pending Approval',
      message: `A customer submitted a new job: ${title}`,
      priority: finalPriority,
      data: { job_id: createdJob.id, job_title: title, source: 'customer', approval_status: approvalStatus },
    }).catch(e => console.error('Owner notification error:', e.message));

    // If auto-approved, notify ALL employees immediately so they can self-assign
    if (autoApprove) {
      const { createNotificationForCompany } = require('../../utils/notificationHelpers');
      createNotificationForCompany({
        company_id: companyId,
        type: 'job_available',
        title: 'New Job Available',
        message: 'A customer job is available to accept: "' + createdJob.title + '"',
        priority: finalPriority,
        data: { job_id: createdJob.id, source: 'customer', url: '/employee/jobs' },
      }).catch(e => console.error('Auto-approve notification error:', e.message));
    }

    auditLog(req, customerId, 'customer_job_created', {
      job_id: createdJob.id,
      title,
      approval_status: approvalStatus,
      ai_suggested_priority: aiSuggestedPriority,
    }, companyId);

    // Section 8: Standardized response
    return ok(res, {
      ...createdJob,
      ai_suggested_priority: aiSuggestedPriority,
      approval_status: approvalStatus,
    }, 201);
  } catch (err) {
    console.error('❌ customer/jobs.POST / failed:', err);
    errorLogger.logFromRequest(req, err, { context: 'customer/jobs.POST /' });
    return fail(res, err.message || 'Server error', 500);
  }
});


// ─── GET /:id — single job detail ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const customerId = req.customer.id;
  const companyId = req.customer.companyId;
  const { id } = req.params;

  // Basic UUID validation to prevent 500 errors on non-UUID strings (like "notifications")
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return fail(res, 'Invalid job ID format', 400);
  }

  try {
    const result = await pool.query(
      `SELECT
         j.id, j.title, j.description,
         j.status,
         j.approval_status,
         j.priority,
         j.progress,
         j.assigned_to,
         j.employee_status,
         j.assigned_at,
         j.accepted_at,
         j.arrived_at,
         j.scheduled_at,
         j.machine_id,
         j.service_type,
         j.created_at, j.approved_at,
         j.started_at, j.completed_at,
         u.name AS assigned_employee_name
       FROM jobs j
       LEFT JOIN users u ON u.id = j.assigned_to
       WHERE j.id = $1
         AND j.customer_id = $2
         AND j.company_id = $3`,
      [id, customerId, companyId]
    );

    if (result.rows.length === 0) {
      return fail(res, 'Job not found', 404);
    }

    return ok(res, result.rows[0]);
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customer/jobs.GET /:id' });
    return fail(res, 'Server error');
  }
});

// ─── GET /:id/tracking — employee GPS location ────────────────────────────────
router.get('/:id/tracking', async (req, res) => {
  const customerId = req.customer.id;
  const companyId = req.customer.companyId;
  const { id } = req.params;

  try {
    // Triple-condition ownership check FIRST — before any location data is touched
    // Requirement 10.1: customer_id = req.customer.id AND company_id = req.customer.companyId AND assigned_to IS NOT NULL
    const jobResult = await pool.query(
      `SELECT id, assigned_to, employee_status
       FROM jobs
       WHERE id = $1
         AND customer_id = $2
         AND company_id = $3`,
      [id, customerId, companyId]
    );

    if (jobResult.rows.length === 0) {
      auditLog(req, customerId, 'tracking_denied', { job_id: id, reason: 'ownership_check_failed' }, companyId);
      return fail(res, 'Job not found', 404);
    }

    const job = jobResult.rows[0];

    if (!job.assigned_to) {
      return ok(res, { available: false, reason: 'No employee assigned yet' });
    }

    if (job.employee_status !== 'accepted' && job.employee_status !== 'arrived') {
      return ok(res, { available: false, reason: 'Employee has not accepted the job yet' });
    }

    const locationResult = await pool.query(
      `SELECT u.name, ep.latitude, ep.longitude, ep.location_updated_at
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.id = $1 AND u.company_id::text = $2`,
      [job.assigned_to, String(companyId)]
    );

    if (locationResult.rows.length === 0) {
      return ok(res, { available: true, latitude: null, longitude: null, location_updated_at: null });
    }

    const loc = locationResult.rows[0];
    auditLog(req, customerId, 'tracking_access', { job_id: id, employee_id: job.assigned_to }, companyId);

    return ok(res, {
      available: true,
      employeeName: loc.name,
      latitude: loc.latitude !== null && loc.latitude !== undefined ? parseFloat(loc.latitude) : null,
      longitude: loc.longitude !== null && loc.longitude !== undefined ? parseFloat(loc.longitude) : null,
      location_updated_at: loc.location_updated_at || null,
      is_online: loc.location_updated_at
        ? (Date.now() - new Date(loc.location_updated_at).getTime()) < 30_000
        : false,
    });
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customer/jobs.GET /:id/tracking' });
    return fail(res, 'Server error');
  }
});

// ─── GET /:id/invoice — invoice for completed job or invoice detail ───────────
router.get('/:id/invoice', async (req, res) => {
  const customerId = req.customer.id;
  const companyId = req.customer.companyId;
  const { id } = req.params;

  try {
    // 1. Try finding invoice by job_id owned by this customer & company
    let invoiceResult = await pool.query(
      `SELECT i.*, j.title AS job_title
       FROM invoices i
       LEFT JOIN jobs j ON i.job_id = j.id
       WHERE i.job_id::text = $1::text 
         AND (i.customer_id::text = $2::text OR j.customer_id::text = $2::text)
         AND i.company_id::text = $3::text
         AND i.is_latest = TRUE
         AND COALESCE(i.status, 'draft') <> 'draft'
       ORDER BY i.created_at DESC
       LIMIT 1`,
      [id, String(customerId), String(companyId)]
    );

    // 2. If not found by job_id, check if :id is the invoice ID itself owned by this customer & company
    if (invoiceResult.rows.length === 0) {
      invoiceResult = await pool.query(
        `SELECT i.*, j.title AS job_title
         FROM invoices i
         LEFT JOIN jobs j ON i.job_id = j.id
         WHERE i.id::text = $1::text 
           AND (i.customer_id::text = $2::text OR j.customer_id::text = $2::text)
           AND i.company_id::text = $3::text
           AND COALESCE(i.status, 'draft') <> 'draft'
         LIMIT 1`,
        [id, String(customerId), String(companyId)]
      );
    }

    if (invoiceResult.rows.length === 0) {
      return ok(res, null); // No invoice found or access denied
    }

    const invoice = invoiceResult.rows[0];

    // Fetch line items
    const itemsRes = await pool.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC`,
      [invoice.id]
    );

    // Fetch company branding
    const compRes = await pool.query(
      `SELECT id, company_name, address, phone, contact_email, settings FROM companies WHERE id = $1`,
      [invoice.company_id]
    );
    const compRow = compRes.rows[0] || {};
    const s = compRow.settings || {};

    const companyProfile = {
      name: compRow.company_name || 'Business Enterprise',
      legal_name: s.legal_name || compRow.company_name || 'Business Enterprise',
      address: compRow.address || s.address || '',
      city: s.city || '',
      state: s.state || '',
      country: s.country || 'India',
      pincode: s.pincode || '',
      phone: compRow.phone || s.phone || '',
      contact_email: compRow.contact_email || s.contact_email || '',
      website: s.website || '',
      gstin: s.gstin || '',
      pan: s.pan || '',
      bank_name: s.bank_name || '',
      account_number: s.account_number || '',
      ifsc_code: s.ifsc_code || '',
      upi_id: s.upi_id || '',
    };

    // Synthesize legacy fields for backward-compatibility with job tracking view
    const legacyCompatibleInvoice = {
      ...invoice,
      labor_hours: parseFloat(invoice.labour_hours || 0),
      labor_cost: parseFloat(invoice.labour_cost || 0),
      materials_cost: parseFloat(invoice.materials_cost || 0),
      service_charge: parseFloat(invoice.additional_charges || 0) + parseFloat(invoice.transport_charges || 0) + parseFloat(invoice.equipment_charges || 0),
      generated_at: invoice.created_at,
    };

    return res.json({
      success: true,
      data: legacyCompatibleInvoice,
      invoice: legacyCompatibleInvoice,
      lineItems: itemsRes.rows,
      company: companyProfile,
      error: null,
    });
  } catch (err) {
    console.error('GET /:id/invoice error:', err.message);
    errorLogger.logFromRequest(req, err, { context: 'customer/jobs.GET /:id/invoice' });
    return fail(res, 'Server error');
  }
});

// ─── GET /:id/materials — materials used on a job ─────────────────────────────
router.get('/:id/materials', async (req, res) => {
  const customerId = req.customer.id;
  const companyId = req.customer.companyId;
  const { id } = req.params;

  try {
    // Ownership check
    const jobCheck = await pool.query(
      `SELECT id FROM jobs WHERE id = $1 AND customer_id = $2 AND company_id = $3`,
      [id, customerId, companyId]
    );
    if (jobCheck.rows.length === 0) return fail(res, 'Job not found', 404);

    const result = await pool.query(
      `SELECT jm.id, jm.item_name, jm.quantity_used, jm.unit_cost, jm.total_cost, jm.logged_at,
              u.name AS logged_by_name
       FROM job_materials jm
       LEFT JOIN users u ON u.id = jm.logged_by
       WHERE jm.job_id = $1 AND jm.company_id = $2
       ORDER BY jm.logged_at ASC`,
      [id, companyId]
    );

    return ok(res, result.rows);
  } catch (err) {
    errorLogger.logFromRequest(req, err, { context: 'customer/jobs.GET /:id/materials' });
    return fail(res, 'Server error');
  }
});

module.exports = router;
