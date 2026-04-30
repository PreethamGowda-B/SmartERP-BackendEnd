/**
 * routes/payments.js — HARDENED
 *
 * - Role guard: only owner/admin can record payments or view full list
 * - Multi-tenant: all queries scoped to company_id
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

function requireOwnerOrAdmin(req, res, next) {
  if (!['owner', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ success: false, error: 'Only owners or admins can manage payments' });
  }
  next();
}

// Record a payment for a payroll entry — owner/admin only, company-scoped
router.post('/pay', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const { payrollEntryId, method, reference } = req.body;
  const companyId = req.user.companyId;

  if (!payrollEntryId) {
    return res.status(400).json({ success: false, error: 'payrollEntryId is required' });
  }

  try {
    // Verify the payroll entry belongs to this company before touching it
    const entryCheck = await pool.query(
      `SELECT pe.id FROM payroll_entries pe
       JOIN payroll p ON p.id = pe.payroll_id
       WHERE pe.id = $1 AND p.company_id::text = $2`,
      [payrollEntryId, String(companyId)]
    );

    if (entryCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Payroll entry not found or access denied' });
    }

    const result = await pool.query(
      'INSERT INTO payroll_payments (payroll_entry_id, paid_at, method, reference) VALUES ($1, NOW(), $2, $3) RETURNING *',
      [payrollEntryId, method || null, reference || null]
    );
    await pool.query('UPDATE payroll_entries SET status = $1 WHERE id = $2', ['paid', payrollEntryId]);

    res.json({ success: true, data: result.rows[0], error: null });
  } catch (err) {
    console.error('payments POST /pay error:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// List payments — company-scoped
router.get('/list', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const companyId = req.user.companyId;
  try {
    const result = await pool.query(
      `SELECT pp.*, pe.user_id AS employee_user_id
       FROM payroll_payments pp
       JOIN payroll_entries pe ON pp.payroll_entry_id = pe.id
       JOIN payroll p ON p.id = pe.payroll_id
       WHERE p.company_id::text = $1
       ORDER BY pp.paid_at DESC`,
      [String(companyId)]
    );
    res.json({ success: true, data: result.rows, error: null });
  } catch (err) {
    console.error('payments GET /list error:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
