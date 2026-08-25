const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireClockIn } = require('../middleware/attendanceGatekeeperMiddleware');
const { createNotificationForOwners, createNotification } = require('../utils/notificationHelpers');
const invoiceService = require('../services/invoiceService');

let isTableInitialized = false;

async function ensureWorkRequestsTable() {
  if (isTableInitialized) return;
  try {
    // 1. Create Base Table
    await pool.query(`
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
    `).catch(() => {});

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
      await pool.query(sql).catch((err) => console.warn(`⚠️ Migration notice: ${err.message}`));
    }

    isTableInitialized = true;
  } catch (err) {
    console.error('❌ Error creating work_requests table:', err.message);
  }
}

// Auto-run on router load
ensureWorkRequestsTable().catch(() => {});

// ─── POST /api/work-requests (Submit a new request) ──────────────────────────
router.post('/', authenticateToken, requireClockIn, async (req, res) => {
  try {
    await ensureWorkRequestsTable();
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

    const result = await pool.query(
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
});

// ─── GET /api/work-requests (List requests with filters) ─────────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    await ensureWorkRequestsTable();
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
      LEFT JOIN jobs j ON r.job_id::text = j.id::text
      LEFT JOIN invoices inv ON r.invoice_id::text = inv.id::text
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role !== 'super_admin') {
      params.push(String(companyId));
      query += ` AND r.company_id::text = $${params.length}::text`;
    }

    if (job_id) {
      params.push(String(job_id));
      query += ` AND r.job_id::text = $${params.length}::text`;
    }
    if (submitted_by_id) {
      params.push(String(submitted_by_id));
      query += ` AND r.submitted_by_id::text = $${params.length}::text`;
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

    const result = await pool.query(query, params);
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    console.error('GET /api/work-requests error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── ACTION HANDLER (Approve / Reject / Reply) ────────────────────────────────
const handleWorkRequestAction = async (req, res) => {
  try {
    await ensureWorkRequestsTable();
    const userRole = req.user.role;
    const isSuperAdmin = userRole === 'super_admin';
    const isAuthorizedRole = ['owner', 'admin', 'hr', 'super_admin'].includes(userRole);

    if (!isAuthorizedRole) {
      return res.status(403).json({ message: 'Access denied: Only owners, admins, or HR can action work requests.' });
    }

    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && !isSuperAdmin) {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }

    const { id } = req.params;
    const { action, owner_response, response_notes, payload = {} } = req.body;
    const notes = owner_response || response_notes || '';

    let newStatus = 'approved';
    if (action === 'reject') newStatus = 'rejected';
    if (action === 'reply' || action === 'request_info') newStatus = 'in_review';
    if (action === 'resolve' || action === 'complete') newStatus = 'resolved';

    let result;
    const userIdStr = String(req.user.id || req.user.userId || "");
    const userNameStr = String(req.user.name || req.user.email || "Owner");

    const updateQuery = isSuperAdmin
      ? `UPDATE work_requests
         SET status = $1,
             owner_response = $2,
             response_notes = $3,
             actioned_by_id = $4,
             actioned_by_name = $5,
             actioned_at = NOW(),
             resolved_by_id = $6,
             resolved_by_name = $7,
             resolved_at = NOW(),
             updated_at = NOW()
         WHERE id::text = $8::text
         RETURNING *`
      : `UPDATE work_requests
         SET status = $1,
             owner_response = $2,
             response_notes = $3,
             actioned_by_id = $4,
             actioned_by_name = $5,
             actioned_at = NOW(),
             resolved_by_id = $6,
             resolved_by_name = $7,
             resolved_at = NOW(),
             updated_at = NOW()
         WHERE id::text = $8::text AND company_id::text = $9::text
         RETURNING *`;

    const updateParams = isSuperAdmin
      ? [newStatus, notes, notes, userIdStr, userNameStr, userIdStr, userNameStr, String(id)]
      : [newStatus, notes, notes, userIdStr, userNameStr, userIdStr, userNameStr, String(id), String(companyId)];

    try {
      result = await pool.query(updateQuery, updateParams);
    } catch (updateErr) {
      console.warn("⚠️ Full update failed, trying safe fallback update:", updateErr.message);
      const fallbackQuery = isSuperAdmin
        ? `UPDATE work_requests
           SET status = $1, response_notes = $2, updated_at = NOW()
           WHERE id::text = $3::text
           RETURNING *`
        : `UPDATE work_requests
           SET status = $1, response_notes = $2, updated_at = NOW()
           WHERE id::text = $3::text AND company_id::text = $4::text
           RETURNING *`;
      const fallbackParams = isSuperAdmin
        ? [newStatus, notes, String(id)]
        : [newStatus, notes, String(id), String(companyId)];
      result = await pool.query(fallbackQuery, fallbackParams);
    }

    if (!result || result.rows.length === 0) {
      return res.status(404).json({ message: 'Request not found or does not belong to your company' });
    }

    const updatedReq = result.rows[0];

    // Handle Specific Side-Effects based on request_type & action
    if (action === 'approve') {
      // 1. Discount Approval
      if (updatedReq.invoice_id && updatedReq.request_type === 'invoice_discount') {
        const approvedDiscount = parseFloat(payload.discount_amount || updatedReq.payload?.discount_amount || 0);
        if (approvedDiscount > 0) {
          const invRes = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [updatedReq.invoice_id]);
          if (invRes.rows.length > 0) {
            const currentInv = invRes.rows[0];
            const newTotal = Math.max(0, parseFloat(currentInv.subtotal || currentInv.total_amount) - approvedDiscount);
            await pool.query(
              `UPDATE invoices SET discount_amount = $1, total_amount = $2, status = 'sent', updated_at = NOW() WHERE id = $3`,
              [approvedDiscount, newTotal, updatedReq.invoice_id]
            );
          }
        }
      }

      // 2. Extra Workers Assignment
      if (updatedReq.job_id && updatedReq.request_type === 'need_more_workers') {
        if (payload.assigned_employee_id) {
          await pool.query(
            `UPDATE jobs SET assigned_to = $1, updated_at = NOW() WHERE id = $2`,
            [payload.assigned_employee_id, updatedReq.job_id]
          );
        }
      }
    }

    // Broadcast Real-Time SSE Notification to Submitter
    if (updatedReq.submitted_by_id) {
      await createNotification({
        user_id: updatedReq.submitted_by_id,
        company_id: companyId,
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
          url: updatedReq.job_id ? `/employee/jobs` : '/notifications'
        }
      }).catch((nErr) => console.warn('⚠️ SSE Notification warning:', nErr.message));
    }

    return res.json({ success: true, request: updatedReq });
  } catch (err) {
    console.error('Work request action error:', err);
    return res.status(500).json({ message: err.message || 'Server error processing request action' });
  }
};

router.patch('/:id/action', authenticateToken, handleWorkRequestAction);
router.post('/:id/action', authenticateToken, handleWorkRequestAction);

module.exports = router;
