const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { registerSSEConnection, unregisterSSEConnection } = require('../utils/notificationHelpers');

// ─── GET /api/notifications ──────────────────────────────────────────────────
// Get all notifications for authenticated user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    console.log('🔍 Fetching notifications for user:', userId);

    const result = await pool.query(
      `SELECT * FROM notifications 
       WHERE user_id = $1 AND company_id = $2 
       ORDER BY created_at DESC 
       LIMIT 100`,
      [userId, companyId]
    );

    console.log(`✅ Found ${result.rows.length} notifications`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching notifications:', err);
    res.status(500).json({ message: 'Server error fetching notifications' });
  }
});

// ─── GET /api/notifications/sse ──────────────────────────────────────────────
// Server-Sent Events endpoint for real-time notifications
router.get('/sse', authenticateToken, (req, res) => {
  const userId = req.user.userId || req.user.id;

  console.log(`📡 SSE connection established for user ${userId}`);

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering for nginx

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'SSE connection established' })}\n\n`);

  // Register this connection
  registerSSEConnection(userId, res);

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch (err) {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`📡 SSE connection closed for user ${userId}`);
    clearInterval(heartbeatInterval);
    unregisterSSEConnection(userId, res);
  });
});

// ─── PATCH /api/notifications/:id/read ───────────────────────────────────────
// Mark a single notification as read
router.patch('/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId || req.user.id;

    const result = await pool.query(
      `UPDATE notifications 
       SET read = TRUE 
       WHERE id = $1 AND user_id = $2 
       RETURNING *`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    console.log(`✅ Notification ${id} marked as read`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error marking notification as read:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PATCH /api/notifications/mark-all-read ──────────────────────────────────
// Mark all notifications as read for the user
router.patch('/mark-all-read', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    const result = await pool.query(
      `UPDATE notifications 
       SET read = TRUE 
       WHERE user_id = $1 AND company_id = $2 AND read = FALSE 
       RETURNING id`,
      [userId, companyId]
    );

    console.log(`✅ Marked ${result.rows.length} notifications as read`);
    res.json({ count: result.rows.length, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('❌ Error marking all as read:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/notifications/unread-count ─────────────────────────────────────
// Get count of unread notifications
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    const result = await pool.query(
      `SELECT COUNT(*) as count 
       FROM notifications 
       WHERE user_id = $1 AND company_id = $2 AND read = FALSE`,
      [userId, companyId]
    );

    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('❌ Error getting unread count:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
