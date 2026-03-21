const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateToken } = require('../middleware/auth');

/**
 * @route   POST /api/feedback
 * @desc    Submit user feedback, bug reports, or feature requests
 * @access  Private
 */
router.post('/', authenticateToken, async (req, res) => {
  const { type, subject, message, pageUrl } = req.body;
  const userId = req.user.id;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO feedback (user_id, type, subject, message, page_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, type || 'general', subject || 'No Subject', message, pageUrl || '']
    );

    console.log(`📝 Feedback received from User ${userId}: [${type}] ${subject}`);

    res.status(201).json({
      success: true,
      message: 'Feedback submitted successfully. Thank you for helping us improve SmartERP!',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('❌ Error saving feedback:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route   GET /api/feedback
 * @desc    Get all feedback (Admin only)
 * @access  Private/Admin
 */
router.get('/', authenticateToken, async (req, res) => {
  // Only owners or admins can view feedback
  if (req.user.role !== 'owner' && req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Unauthorized to view feedback' });
  }

  try {
    const result = await pool.query(
      `SELECT f.*, u.name as user_name, u.email as user_email 
       FROM feedback f
       LEFT JOIN users u ON f.user_id = u.id
       ORDER BY f.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching feedback:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
