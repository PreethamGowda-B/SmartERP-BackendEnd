/**
 * routes/analytics.js — HARDENED
 *
 * All queries scoped to req.user.companyId.
 * No cross-tenant data leaks.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    if (!companyId) {
      return res.status(400).json({ success: false, error: 'Missing company context' });
    }

    const [users, jobs, inventory] = await Promise.all([
      pool.query(
        'SELECT COUNT(*)::int AS count FROM users WHERE company_id::text = $1',
        [String(companyId)]
      ),
      pool.query(
        'SELECT COUNT(*)::int AS count FROM jobs WHERE company_id::text = $1',
        [String(companyId)]
      ),
      pool.query(
        'SELECT COUNT(*)::int AS count FROM inventory_items WHERE company_id::text = $1',
        [String(companyId)]
      ),
    ]);

    res.json({
      success: true,
      data: {
        users: users.rows[0].count,
        jobs: jobs.rows[0].count,
        inventory: inventory.rows[0].count,
      },
      error: null,
    });
  } catch (err) {
    console.error('Analytics summary error:', err.message);
    res.status(500).json({ success: false, data: null, error: 'Server error' });
  }
});

module.exports = router;
