const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    const jobs = await pool.query('SELECT COUNT(*)::int AS count FROM jobs');
    const inventory = await pool.query('SELECT COUNT(*)::int AS count FROM inventory_items');
    res.json({ users: users.rows[0].count, jobs: jobs.rows[0].count, inventory: inventory.rows[0].count });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
