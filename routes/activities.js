const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

;(async function ensureColumns() {
  try {
    await pool.query("ALTER TABLE activities ADD COLUMN IF NOT EXISTS details JSONB");
  } catch (err) {
    console.warn('Could not ensure activities.details column exists:', err.message || err);
  }
})();

// Log activity (supports action and details payload)
router.post('/', authenticateToken, async (req, res) => {
  const { action, details } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO activities (user_id, action, details) VALUES ($1, $2, $3) RETURNING *',
      [req.user.userId, action, details || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('activities POST error', err)
    res.status(500).json({ message: 'Server error' });
  }
});

// Get recent activities for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM activities WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 50', [req.user.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('activities GET error', err)
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;