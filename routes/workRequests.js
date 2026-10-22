const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireClockIn } = require('../middleware/attendanceGatekeeperMiddleware');
const { createNotificationForOwners, createNotification } = require('../utils/notificationHelpers');
const invoiceService = require('../services/invoiceService');

const WORK_REQUEST_TRANSITIONS = Object.freeze({
  pending: new Set(['approve', 'reject', 'reply', 'request_info']),
  in_review: new Set(['approve', 'reject', 'reply', 'request_info', 'resolve', 'complete']),
  approved: new Set(['resolve', 'complete']),
  rejected: new Set(),
  resolved: new Set(),
});

function canTransitionWorkRequest(currentStatus, action) {
  return WORK_REQUEST_TRANSITIONS[String(currentStatus || '').toLowerCase()]?.has(action) === true;
}

let isTableInitialized = false;

async function ensureWorkRequestsTable() {
  if (isTableInitialized) return;
  let client;
  try {
    client = await pool.connect();

    // 1. Create Base Table if missing
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id TEXT,
        request_type VARCHAR(100) NOT NULL,
        category VARCHAR(50) DEFAULT 'jobs',
        urgency VARCHAR(20) DEFAULT 'normal',
        status VARCHAR(20) DEFAULT 'pending',
        submitted_by_id TEXT,
        submitted_by_name VARCHAR(255),
        submitted_by_role VARCHAR(50),
        job_id TEXT,
        invoice_id TEXT,
        material_request_id TEXT,
        leave_request_id TEXT,
        title VARCHAR(255) NOT NULL,
        reason TEXT,
        response_notes TEXT,
        owner_response TEXT,
        actioned_by_id TEXT,
        actioned_by_name VARCHAR(255),
        actioned_at TIMESTAMP WITH TIME ZONE,
        resolved_by_id TEXT,
        resolved_by_name VARCHAR(255),
        resolved_at TIMESTAMP WITH TIME ZONE,
        evidence_urls JSONB DEFAULT '[]'::jsonb,
        payload JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `).catch((err) => {
      console.warn('ensureWorkRequestsTable base table note:', err.message);
    });

    // 2. Independently add each column with fail-safe guards
    const safeAlterColumns = [
      "ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS owner_response TEXT;",
      "ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS response_notes TEXT;",
      "ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS actioned_by_id TEXT;",
      "ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS actioned_by_name VARCHAR(255);",
      "ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS actioned_at TIMESTAMP WITH TIME ZONE;",
      "ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS resolved_by_id TEXT;",
      "ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS resolved_by_name VARCHAR(255);",
      "ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP WITH TIME ZONE;",
      "CREATE INDEX IF NOT EXISTS idx_work_requests_company ON work_requests(company_id);",
      "CREATE INDEX IF NOT EXISTS idx_work_requests_status ON work_requests(status);",
      "CREATE INDEX IF NOT EXISTS idx_work_requests_job ON work_requests(job_id);"
    ];

    for (const sql of safeAlterColumns) {
      await client.query(sql).catch((err) => {
        // Safe check for already-existing columns/indexes
        if (!['42701', '42P07'].includes(err?.code)) {
          console.warn('ensureWorkRequestsTable alter column warning:', err.message);
        }
      });
    }

    isTableInitialized = true;
  } catch (err) {
    console.warn('ensureWorkRequestsTable initialization failed:', err.message);
  } finally {
    if (client) client.release();
  }
}

// Auto-run on router load (disabled during unit testing to prevent accidental DB connections)
if (process.env.NODE_ENV !== 'test') {
  ensureWorkRequestsTable().catch(() => {});
}

// ─── POST /api/work-requests (Submit a new request) ──────────────────────────
function createWorkRequestSubmitHandler({ db = pool, ensureSchema = ensureWorkRequestsTable } = {}) {
  return async (req, res) => {
    try {
      await ensureSchema();
      const companyId = req.user.companyId || req.user.company_id;
      if (!companyId) {
        return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
      }
      const {
        request_type,
        category = 'jobs',
        urgency = 'normal',
        job_id,
        invoice_id,
        material_request_id,
        leave_request_id,
        title,
        reason,
        evidence_urls = [],
        payload = {}
      } = req.body;

      if (!title || !request_type) {
        return res.status(400).json({ message: 'Title and request_type are required' });
      }

      // Validate linked records within company boundary before inserting
      if (job_id) {
        const jobCheck = await db.query(
          `SELECT id FROM jobs WHERE id::text = $1::text AND company_id::text = $2::text LIMIT 1`,
          [String(job_id), String(companyId)]
        );
        if (!jobCheck.rows?.length) {
          return res.status(404).json({ success: false, message: 'The linked job was not found for this company.' });
        }
      }

      if (invoice_id) {
        const invCheck = await db.query(
          `SELECT id FROM invoices WHERE id::text = $1::text AND company_id::text = $2::text LIMIT 1`,
          [String(invoice_id), String(companyId)]
        );
        if (!invCheck.rows?.length) {
          return res.status(404).json({ success: false, message: 'The linked invoice was not found for this company.' });
        }
      }

      if (material_request_id) {
        const matCheck = await db.query(
          `SELECT id FROM material_requests WHERE id::text = $1::text AND company_id::text = $2::text LIMIT 1`,
          [String(material_request_id), String(companyId)]
        ).catch(() => ({ rows: [] }));
        const tableCheck = await db.query(
          "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'material_requests';"
        ).catch(() => ({ rows: [] }));
        if (tableCheck.rows?.length && !matCheck.rows?.length) {
          return res.status(404).json({ success: false, message: 'The linked material request was not found for this company.' });
        }
      }

      const result = await db.query(
        `INSERT INTO work_requests (
          company_id, request_type, category, urgency, status,
          submitted_by_id, submitted_by_name, submitted_by_role,
          job_id, invoice_id, material_request_id, leave_request_id,
          title, reason, evidence_urls, payload,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
        RETURNING *`,
        [
          String(companyId),
          request_type,
          category,
          urgency,
          String(req.user.id || req.user.userId),
          req.user.name || req.user.email,
          req.user.role || 'employee',
          job_id ? String(job_id) : null,
          invoice_id ? String(invoice_id) : null,
          material_request_id ? String(material_request_id) : null,
          leave_request_id ? String(leave_request_id) : null,
          title,
          reason || '',
          JSON.stringify(evidence_urls),
          JSON.stringify(payload)
        ]
      );

      const newReq = result.rows[0];

      // Real-Time Notification to Owners
      await createNotificationForOwners({
        company_id: companyId,
        type: 'work_request',
        title: urgency === 'emergency' ? '🚨 EMERGENCY WORK REQUEST' : `Approval Request: ${title}`,
        message: `${req.user.name || 'User'} submitted ${request_type.replace(/_/g, ' ')}: ${reason || title}`,
        priority: urgency === 'emergency' ? 'urgent' : urgency === 'high' ? 'high' : 'normal',
        data: { request_id: newReq.id, request_type, category, job_id: newReq.job_id }
      }).catch(() => {});

      res.status(201).json({ success: true, request: newReq });
    } catch (err) {
      console.error('POST /api/work-requests error:', err);
      res.status(500).json({ message: err.message || 'Server error' });
    }
  };
}

router.post('/', authenticateToken, requireClockIn, createWorkRequestSubmitHandler());

// ─── GET /api/work-requests (List requests with filters) ─────────────────────
function createWorkRequestListHandler({ db = pool, ensureSchema = ensureWorkRequestsTable } = {}) {
  return async (req, res) => {
    try {
      await ensureSchema();
      const companyId = req.user.companyId || req.user.company_id;
      if (!companyId && req.user.role !== 'super_admin') {
        return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
      }
      const { category, status, urgency, search, job_id, submitted_by_id } = req.query;

      let query = `
        SELECT r.*,
               j.title AS job_title, j.location AS job_location,
               inv.invoice_number, inv.total_amount AS invoice_total
        FROM work_requests r
        LEFT JOIN jobs j ON r.job_id::text = j.id::text AND j.company_id::text = r.company_id::text
        LEFT JOIN invoices inv ON r.invoice_id::text = inv.id::text AND inv.company_id::text = r.company_id::text
        WHERE 1=1
      `;
      const params = [];

      if (req.user.role !== 'super_admin') {
        params.push(String(companyId));
        query += ` AND r.company_id::text = $${params.length}::text`;
      }

      // Role-based data minimization: employees only see their own submitted requests
      const callerRole = String(req.user.role || '').toLowerCase();
      if (callerRole === 'employee') {
        params.push(String(req.user.id || req.user.userId));
        query += ` AND r.submitted_by_id::text = $${params.length}::text`;
      } else if (submitted_by_id) {
        params.push(String(submitted_by_id));
        query += ` AND r.submitted_by_id::text = $${params.length}::text`;
      }

      if (job_id) {
        params.push(String(job_id));
        query += ` AND r.job_id::text = $${params.length}::text`;
      }
      if (category && category !== 'all') {
        params.push(category);
        query += ` AND r.category = $${params.length}`;
      }
      if (status && status !== 'all') {
        params.push(status);
        query += ` AND r.status = $${params.length}`;
      }
      if (urgency && urgency !== 'all') {
        params.push(urgency);
        query += ` AND r.urgency = $${params.length}`;
      }
      if (search) {
        params.push(`%${search}%`);
        query += ` AND (r.title ILIKE $${params.length} OR r.submitted_by_name ILIKE $${params.length} OR r.reason ILIKE $${params.length})`;
      }

      query += ` ORDER BY r.created_at DESC`;

      const result = await db.query(query, params);
      res.json({ success: true, requests: result.rows });
    } catch (err) {
      console.error('GET /api/work-requests error:', err);
      res.status(500).json({ message: err.message || 'Server error' });
    }
  };
}

router.get('/', authenticateToken, createWorkRequestListHandler());

// ─── ACTION HANDLER (Approve / Reject / Reply) ────────────────────────────────
function createWorkRequestActionHandler({ db = pool, ensureSchema = ensureWorkRequestsTable, notify = createNotification } = {}) {
  return async (req, res) => {
    let client;
    let transactionOpen = false;
    try {
      await ensureSchema();
      const userRole = String(req.user?.role || '').toLowerCase();
      const isSuperAdmin = userRole === 'super_admin';
      if (!['owner', 'admin', 'hr', 'super_admin'].includes(userRole)) {
        return res.status(403).json({ message: 'Access denied: Only owners, admins, or HR can action work requests.' });
      }

      const companyId = req.user.companyId || req.user.company_id;
      if (!companyId && !isSuperAdmin) {
        return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
      }

      const { id } = req.params;
      const { action, owner_response, response_notes, payload = {} } = req.body || {};
      const statusByAction = {
        approve: 'approved',
        reject: 'rejected',
        reply: 'in_review',
        request_info: 'in_review',
        resolve: 'resolved',
        complete: 'resolved',
      };
      if (!Object.hasOwn(statusByAction, action)) {
        return res.status(400).json({ message: 'Unsupported work request action.' });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ message: 'payload must be an object.' });
      }
      const notes = owner_response || response_notes || '';
      const newStatus = statusByAction[action];
      const userIdStr = String(req.user.id || req.user.userId || '');
      const userNameStr = String(req.user.name || req.user.email || 'Owner');

      client = await db.connect();
      await client.query('BEGIN');
      transactionOpen = true;

      const requestParams = isSuperAdmin ? [String(id)] : [String(id), String(companyId)];
      const requestQuery = isSuperAdmin
        ? `SELECT * FROM work_requests WHERE id::text = $1::text FOR UPDATE`
        : `SELECT * FROM work_requests WHERE id::text = $1::text AND company_id::text = $2::text FOR UPDATE`;
      const requestResult = await client.query(requestQuery, requestParams);
      if (!requestResult.rows.length) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(404).json({ message: 'Request not found or does not belong to your company' });
      }
      const request = requestResult.rows[0];
      const effectiveCompanyId = String(request.company_id);
      if (!request.company_id) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(409).json({ message: 'This request has no company context and cannot be safely actioned.' });
      }

      if (action === 'approve' && request.request_type === 'invoice_discount' && !['owner', 'admin', 'super_admin'].includes(userRole)) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(403).json({ message: 'Only an owner or administrator can approve invoice discounts.' });
      }
      if (!canTransitionWorkRequest(request.status, action)) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(409).json({ message: `Action ${action} is not allowed while this request is ${request.status || 'in an unknown state'}.` });
      }

      if (action === 'approve' && request.invoice_id && request.request_type === 'invoice_discount') {
        const rawDiscount = payload.discount_amount ?? request.payload?.discount_amount ?? 0;
        const approvedDiscount = Number(rawDiscount);
        if (!Number.isFinite(approvedDiscount) || approvedDiscount < 0) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return res.status(400).json({ message: 'discount_amount must be a finite non-negative amount.' });
        }
        if (approvedDiscount > 0) {
          const invoice = await client.query(
            `SELECT * FROM invoices WHERE id::text = $1::text AND company_id::text = $2::text FOR UPDATE`,
            [String(request.invoice_id), effectiveCompanyId]
          );
          if (!invoice.rows.length) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(409).json({ message: 'The linked invoice was not found for this company; the request was not approved.' });
          }
          const currentInvoice = invoice.rows[0];
          const invoiceBase = Number(currentInvoice.subtotal ?? currentInvoice.total_amount);
          if (!Number.isFinite(invoiceBase)) throw new Error('The linked invoice total is invalid.');
          const newTotal = Math.max(0, invoiceBase - approvedDiscount);
          const invoiceUpdate = await client.query(
            `UPDATE invoices SET discount_amount = $1, total_amount = $2, status = 'sent', updated_at = NOW()
             WHERE id::text = $3::text AND company_id::text = $4::text RETURNING id`,
            [approvedDiscount, newTotal, String(request.invoice_id), effectiveCompanyId]
          );
          if (!invoiceUpdate.rows.length) throw new Error('The linked invoice was not updated.');
        }
      }

      if (action === 'approve' && request.job_id && request.request_type === 'need_more_workers' && payload.assigned_employee_id) {
        const job = await client.query(
          `SELECT id FROM jobs WHERE id::text = $1::text AND company_id::text = $2::text FOR UPDATE`,
          [String(request.job_id), effectiveCompanyId]
        );
        if (!job.rows.length) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return res.status(409).json({ message: 'The linked job was not found for this company; the request was not approved.' });
        }
        const employee = await client.query(
          `SELECT id FROM users WHERE id::text = $1::text AND company_id::text = $2::text`,
          [String(payload.assigned_employee_id), effectiveCompanyId]
        );
        if (!employee.rows.length) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return res.status(409).json({ message: 'The selected employee was not found for this company; the request was not approved.' });
        }
        const jobUpdate = await client.query(
          `UPDATE jobs SET assigned_to = $1, updated_at = NOW()
           WHERE id::text = $2::text AND company_id::text = $3::text RETURNING id`,
          [String(payload.assigned_employee_id), String(request.job_id), effectiveCompanyId]
        );
        if (!jobUpdate.rows.length) throw new Error('The linked job assignment was not updated.');
      }

      const update = await client.query(
        `UPDATE work_requests
         SET status = $1, owner_response = $2, response_notes = $3,
             actioned_by_id = $4, actioned_by_name = $5, actioned_at = NOW(),
             resolved_by_id = $6, resolved_by_name = $7, resolved_at = NOW(), updated_at = NOW()
         WHERE id::text = $8::text AND company_id::text = $9::text RETURNING *`,
        [newStatus, notes, notes, userIdStr, userNameStr, userIdStr, userNameStr, String(id), effectiveCompanyId]
      );
      if (!update.rows.length) throw new Error('The work request was not updated.');

      await client.query('COMMIT');
      transactionOpen = false;
      const updatedReq = update.rows[0];

      if (updatedReq.submitted_by_id) {
        await notify({
          user_id: updatedReq.submitted_by_id,
          company_id: effectiveCompanyId,
          type: 'work_request_response',
          title: `Request ${newStatus === 'approved' ? 'Approved ✅' : newStatus === 'rejected' ? 'Rejected ❌' : 'Updated 💬'}`,
          message: `Your request (${updatedReq.title}) was ${newStatus}${notes ? `: ${notes}` : '.'}`,
          priority: 'high',
          data: {
            request_id: id,
            job_id: updatedReq.job_id,
            status: newStatus,
            owner_response: notes,
            actioned_by_name: req.user.name || 'Owner',
            actioned_at: new Date().toISOString(),
            url: updatedReq.job_id ? '/employee/jobs' : '/notifications',
          },
        }).catch((notificationError) => console.warn('Work request notification failed:', notificationError?.code || 'NOTIFICATION_ERROR'));
      }

      return res.json({ success: true, request: updatedReq });
    } catch (err) {
      if (transactionOpen && client) await client.query('ROLLBACK').catch(() => {});
      console.error('Work request action failed:', err?.code || 'WORK_REQUEST_ACTION_ERROR');
      return res.status(500).json({ message: 'Server error processing request action.' });
    } finally {
      client?.release();
    }
  };
}

const handleWorkRequestAction = createWorkRequestActionHandler();

router.patch('/:id/action', authenticateToken, handleWorkRequestAction);
router.post('/:id/action', authenticateToken, handleWorkRequestAction);

module.exports = router;
module.exports.createWorkRequestSubmitHandler = createWorkRequestSubmitHandler;
module.exports.createWorkRequestListHandler = createWorkRequestListHandler;
module.exports.createWorkRequestActionHandler = createWorkRequestActionHandler;
module.exports.canTransitionWorkRequest = canTransitionWorkRequest;
