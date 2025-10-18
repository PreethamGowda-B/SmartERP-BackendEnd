const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC', [req.user.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.post('/', authenticateToken, async (req, res) => {
  const { title, message, userId } = req.body;
  try {
    const result = await pool.query('INSERT INTO notifications (user_id, title, message) VALUES ($1,$2,$3) RETURNING *', [userId || req.user.userId, title, message]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
