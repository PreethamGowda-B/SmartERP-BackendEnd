const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// Record a payment for a payroll entry
router.post('/pay', authenticateToken, async (req, res) => {
  const { payrollEntryId, method, reference } = req.body;
  try {
    const result = await pool.query('INSERT INTO payroll_payments (payroll_entry_id, paid_at, method, reference) VALUES ($1, NOW(), $2, $3) RETURNING *', [payrollEntryId, method, reference]);
    // mark entry as paid
    await pool.query('UPDATE payroll_entries SET status = $1 WHERE id = $2', ['paid', payrollEntryId]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.get('/list', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT p.*, e.user_id FROM payroll_payments p JOIN payroll_entries e ON p.payroll_entry_id = e.id ORDER BY p.paid_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
