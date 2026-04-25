/**
 * routes/customer/jobs.js
 *
 * Customer Portal job routes — all protected by authenticateCustomer.
 * Every query is double-filtered by customer_id AND company_id.
 *
 *   GET  /           — list own jobs (paginated)
 *   POST /           — create a new job
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
  createNotificationForCompany,
} = require('../../utils/notificationHelpers');

// ─── Audit log helper (non-blocking) ─────────────────────────────────────────
function auditLog(req, customerId, action, details, companyId) {
  pool.query(
    `INSERT INTO activities (user_id, action, activity_type, details, ip_address, user_agent, company_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      customerId || null,
      action,
      'customer_job',
      JSON.stringify(details || {}),
      req.ip,
      req.get('user-agent'),
      companyId || null,
    ]
  ).catch(e => console.error('Audit log error:', e.message));
}

// ─── GET / — list own jobs ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const customerId = req.customer.id;
  const companyId = req.customer.companyId;

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  try {
    const result = await pool.query(
      `SELECT
         j.id, j.title, j.description, j.status, j.priority,
         j.employee_status, j.progress, j.assigned_to,
         j.created_at, j.accepted_at, j.completed_at, j.source,
         u.name AS assigned_employee_name
       FROM jobs j
       LEFT JOIN users u ON u.id = j.assigned_to
       WHERE j.customer_id = $1
         AND j.company_id = $2
       ORDER BY j.created_at DESC
       LIMIT $3 OFFSET $4`,
      [customerId, companyId, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM jobs WHERE customer_id = $1 AND company_id = $2`,
      [customerId, companyId]
    );

    return res.json({
      jobs: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    console.error('customer jobs GET error:', err.message);
    return res.status(500).json({ message: 'Server error' });
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
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const firstError = errors.array()[0];
    return res.status(400).json({ message: firstError.msg });
  }

  const customerId = req.customer.id;
  const companyId = req.customer.companyId;
  const { title, description, priority } = req.body;

  // Redis-based rate limit: max 10 job creations per minute per customer
  try {
    if (redisClient && redisClient.status === 'ready') {
      const rateLimitKey = `customer_job_create:${customerId}`;
      const count = await redisClient.incr(rateLimitKey);
      if (count === 1) {
        await redisClient.expire(rateLimitKey, 60); // 1-minute window
      }
      if (count > 10) {
        const ttl = await redisClient.ttl(rateLimitKey);
        return res.status(429).json({
          message: 'Too many job submissions. Please wait before submitting again.',
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
    const companyCheck = await pool.query(
      'SELECT status, subscription_status FROM companies WHERE id = $1',
      [companyId]
    );
    const company = companyCheck.rows[0];
    if (company) {
      if (company.status === 'suspended') {
        return res.status(403).json({ message: 'Account Suspended/Disabled' });
      }
      if (company.subscription_status === 'expired' || company.subscription_status === 'cancelled') {
        return res.status(403).json({ message: 'Company subscription inactive' });
      }
    }
    const result = await pool.query(
      `INSERT INTO jobs
         (title, description, priority, status, customer_id, company_id,
          source, visible_to_all, created_by, employee_status)
       VALUES ($1, $2, $3, 'open', $4, $5, 'customer', TRUE, NULL, 'pending')
       RETURNING *`,
      [title, description || null, priority || 'medium', customerId, companyId]
    );

    const createdJob = result.rows[0];

    // Notify owners and employees (non-blocking)
    createNotificationForOwners({
      company_id: companyId,
      type: 'job',
      title: 'New Customer Job',
      message: `A customer submitted a new job: ${title}`,
      priority: priority || 'medium',
      data: { job_id: createdJob.id, job_title: title, source: 'customer' },
    }).catch(e => console.error('Owner notification error:', e.message));

    createNotificationForCompany({
      company_id: companyId,
      type: 'job',
      title: 'New Job Available',
      message: `A new customer job is available: ${title}`,
      priority: priority || 'medium',
      data: { job_id: createdJob.id, job_title: title, source: 'customer' },
    }).catch(e => console.error('Employee notification error:', e.message));

    auditLog(req, customerId, 'customer_job_created', { job_id: createdJob.id, title }, companyId);

    return res.status(201).json(createdJob);
  } catch (err) {
    console.error('customer jobs POST error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /:id — single job detail ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const customerId = req.customer.id;
  const companyId = req.customer.companyId;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT
         j.id, j.title, j.description, j.status, j.priority,
         j.employee_status, j.progress, j.assigned_to,
         j.created_at, j.accepted_at, j.completed_at, j.declined_at,
         j.source, j.customer_id,
         u.name AS assigned_employee_name
       FROM jobs j
       LEFT JOIN users u ON u.id = j.assigned_to
       WHERE j.id = $1
         AND j.customer_id = $2
         AND j.company_id = $3`,
      [id, customerId, companyId]
    );

    // Return 404 regardless of whether the job exists for another customer (no info leakage)
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Job not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('customer jobs GET /:id error:', err.message);
    return res.status(500).json({ message: 'Server error' });
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
      // Return 404 without revealing whether the job exists (Requirement 10.1)
      auditLog(req, customerId, 'tracking_denied', { job_id: id, reason: 'ownership_check_failed' }, companyId);
      return res.status(404).json({ message: 'Job not found' });
    }

    const job = jobResult.rows[0];

    // Check assigned_to IS NOT NULL (third condition of triple-check)
    if (!job.assigned_to) {
      return res.json({ available: false, reason: 'No employee assigned yet' });
    }

    // Check employee has accepted the job
    if (job.employee_status !== 'accepted') {
      return res.json({ available: false, reason: 'Employee has not accepted the job yet' });
    }

    // Fetch employee location from employee_profiles
    // Employee ID is derived ONLY from jobs.assigned_to — never from client input (Requirement 10.7)
    const locationResult = await pool.query(
      `SELECT
         u.name,
         ep.latitude,
         ep.longitude,
         ep.location_updated_at
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.id = $1`,
      [job.assigned_to]
    );

    if (locationResult.rows.length === 0) {
      return res.json({ available: true, latitude: null, longitude: null, location_updated_at: null });
    }

    const loc = locationResult.rows[0];

    auditLog(req, customerId, 'tracking_access', { job_id: id, employee_id: job.assigned_to }, companyId);

    return res.json({
      available: true,
      employeeName: loc.name,
      latitude: loc.latitude ? parseFloat(loc.latitude) : null,
      longitude: loc.longitude ? parseFloat(loc.longitude) : null,
      location_updated_at: loc.location_updated_at || null,
      is_online: loc.location_updated_at
        ? (Date.now() - new Date(loc.location_updated_at).getTime()) < 30_000
        : false,
    });
  } catch (err) {
    console.error('customer tracking GET error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
