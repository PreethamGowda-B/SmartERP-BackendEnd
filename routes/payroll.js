const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// Create payroll run
router.post('/runs', authenticateToken, async (req, res) => {
  const { runDate, periodStart, periodEnd } = req.body;
  try {
    const result = await pool.query('INSERT INTO payroll_runs (run_date, period_start, period_end) VALUES ($1,$2,$3) RETURNING *', [runDate, periodStart, periodEnd]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Add payroll entry
router.post('/entries', authenticateToken, async (req, res) => {
  const { payrollRunId, userId, grossAmount, deductions } = req.body;
  try {
    const net = (grossAmount || 0) - (deductions || 0);
    const result = await pool.query('INSERT INTO payroll_entries (payroll_run_id, user_id, gross_amount, deductions, net_amount) VALUES ($1,$2,$3,$4,$5) RETURNING *', [payrollRunId, userId, grossAmount, deductions || 0, net]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// List payroll runs
router.get('/runs', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payroll_runs ORDER BY run_date DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;