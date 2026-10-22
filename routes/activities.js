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
  const companyId = req.user.companyId || req.user.company_id || null;

  try {
    const result = await pool.query(
      'INSERT INTO activities (user_id, company_id, action, details, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
      [userId, companyId, action, details || null]
    );
    res.status(201).json({ success: true, activity: result.rows[0] });
  } catch (err) {
    console.error('❌ Error logging activity:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/activities (Fetch System Audit Trail Logs) ───────────────────
function createActivityReadHandler(query = pool.query.bind(pool)) {
  return async (req, res) => {
    if (req.user?.role === 'super_admin') {
      return res.status(403).json({ message: 'Use the protected administrative audit-trail endpoint.' });
    }
    const companyId = req.user?.companyId || req.user?.company_id;
    if (!companyId) {
      return res.status(403).json({ message: 'Company context is required to read activity history.' });
    }
    try {
      const result = await query(
      `SELECT a.id, a.user_id, a.action, a.details, COALESCE(a.created_at, a.timestamp, NOW()) as created_at,
              COALESCE(u.name, 'System Admin') as user_name,
              COALESCE(u.email, 'admin@prozync.in') as user_email,
              COALESCE(u.role, 'owner') as user_role
       FROM activities a
       LEFT JOIN users u ON a.user_id::text = u.id::text
                       AND u.company_id::text = $1::text
       WHERE a.company_id::text = $1::text
          OR (a.company_id IS NULL AND EXISTS (
            SELECT 1 FROM users scoped_user
            WHERE scoped_user.id::text = a.user_id::text
              AND scoped_user.company_id::text = $1::text
          ))
       ORDER BY COALESCE(a.created_at, a.timestamp, NOW()) DESC LIMIT 100`
      , [String(companyId)]);
      return res.json({ success: true, activities: result.rows });
    } catch (err) {
      console.error('❌ Error fetching activities audit trail:', err.message);
      return res.status(500).json({ message: 'Server error' });
    }
  };
}

router.get('/', authenticateToken, createActivityReadHandler());

module.exports = router;
module.exports.createActivityReadHandler = createActivityReadHandler;
