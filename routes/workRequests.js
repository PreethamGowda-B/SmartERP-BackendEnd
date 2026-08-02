const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotificationForOwners, createNotification } = require('../utils/notificationHelpers');
const invoiceService = require('../services/invoiceService');

/**
 * POST /api/work-requests
 * Submits a new canonical work request from any module (Employee, Customer, System)
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
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
        companyId,
        request_type,
        category,
        urgency,
        req.user.id,
        req.user.name || req.user.email,
        req.user.role || 'employee',
        job_id || null,
        invoice_id || null,
        material_request_id || null,
        leave_request_id || null,
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
      data: { request_id: newReq.id, request_type, category }
    }).catch(() => {});

    res.status(201).json({ success: true, request: newReq });
  } catch (err) {
    console.error('POST /api/work-requests error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

/**
 * GET /api/work-requests
 * Lists filtered work requests for Owner Executive Work Queue
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { category, status, urgency, search } = req.query;

    let query = `
      SELECT r.*,
             j.title AS job_title, j.location AS job_location,
             inv.invoice_number, inv.total_amount AS invoice_total
      FROM work_requests r
      LEFT JOIN jobs j ON r.job_id = j.id
      LEFT JOIN invoices inv ON r.invoice_id = inv.id
      WHERE r.company_id = $1
    `;
    const params = [companyId];

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

/**
 * PATCH /api/work-requests/:id/action
 * Inline action handler for Owner (Approve, Reject, Reply, Assign, Forward)
 */
router.patch('/:id/action', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { id } = req.params;
    const { action, owner_response, payload = {} } = req.body;

    let newStatus = 'approved';
    if (action === 'reject') newStatus = 'rejected';
    if (action === 'reply' || action === 'request_info') newStatus = 'in_review';
    if (action === 'resolve' || action === 'complete') newStatus = 'resolved';

    const result = await pool.query(
      `UPDATE work_requests
       SET status = $1,
           owner_response = $2,
           actioned_by_id = $3,
           actioned_by_name = $4,
           actioned_at = NOW(),
           updated_at = NOW()
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [newStatus, owner_response || '', req.user.id, req.user.name || 'Owner', id, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Request not found' });
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

    // Notify Submitter via Real-Time Notification
    if (updatedReq.submitted_by_id) {
      await createNotification({
        user_id: updatedReq.submitted_by_id,
        company_id: companyId,
        type: 'work_request_response',
        title: `Request ${newStatus === 'approved' ? 'Approved ✅' : newStatus === 'rejected' ? 'Rejected ❌' : 'Updated 💬'}`,
        message: `Your request (${updatedReq.title}) was ${newStatus}${owner_response ? `: ${owner_response}` : '.'}`,
        priority: 'high',
        data: { request_id: id, status: newStatus }
      }).catch(() => {});
    }

    res.json({ success: true, request: updatedReq });
  } catch (err) {
    console.error('PATCH /api/work-requests/:id/action error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
