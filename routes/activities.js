const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { body, validationResult } = require('express-validator');

// ─── POST /api/activities (Log System Audit Activity) ──────────────────────
router.post('/', authenticateToken, [
  body('action').notEmpty().withMessage('action is required').isString().trim().escape(),
  body('details').optional().isObject().withMessage('details must be an object')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
  }
  const { action, details } = req.body;
  const userId = req.user.userId || req.user.id || '00000000-0000-0000-0000-000000000000';

  try {
    const result = await pool.query(
      'INSERT INTO activities (user_id, action, details, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [userId, action, details || null]
    );
    res.status(201).json({ success: true, activity: result.rows[0] });
  } catch (err) {
    console.error('❌ Error logging activity:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/activities (Fetch System Audit Trail Logs) ───────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;

    const result = await pool.query(
      `SELECT a.id, a.user_id, a.action, a.details, COALESCE(a.created_at, a.timestamp, NOW()) as created_at,
              COALESCE(u.name, 'System Admin') as user_name,
              COALESCE(u.email, 'admin@prozync.in') as user_email,
              COALESCE(u.role, 'owner') as user_role
       FROM activities a
       LEFT JOIN users u ON a.user_id::text = u.id::text
       ORDER BY COALESCE(a.created_at, a.timestamp, NOW()) DESC LIMIT 100`
    ).catch(() => ({ rows: [] }));

    res.json({ success: true, activities: result.rows });
  } catch (err) {
    console.error('❌ Error fetching activities audit trail:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;