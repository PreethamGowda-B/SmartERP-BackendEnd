const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// Clock in
router.post('/clock-in', authenticateToken, async (req, res) => {
  const { jobId, location, notes } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO attendance_records (user_id, job_id, company_id, clock_in, location, notes) VALUES ($1, $2, $3, NOW(), $4, $5) RETURNING *',
      [req.user.userId, jobId || null, req.user.companyId, location || null, notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Clock out
router.post('/clock-out', authenticateToken, async (req, res) => {
  const { recordId } = req.body;
  try {
    const rec = await pool.query('SELECT * FROM attendance_records WHERE id = $1 AND user_id = $2 AND company_id = $3', [recordId, req.user.userId, req.user.companyId]);
    if (rec.rows.length === 0) return res.status(404).json({ message: 'Record not found' });
    const clockIn = rec.rows[0].clock_in;
    const result = await pool.query(
      'UPDATE attendance_records SET clock_out = NOW(), duration_seconds = EXTRACT(EPOCH FROM (NOW() - $1))::int, status = $2 WHERE id = $3 RETURNING *',
      [clockIn, 'completed', recordId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get recent attendance
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM attendance_records WHERE user_id = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 100', [req.user.userId, req.user.companyId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;