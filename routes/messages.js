const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── POST /api/messages ───────────────────────────────────────────────────────
// Send a new message
router.post('/', authenticateToken, async (req, res) => {
    try {
        const senderId = req.user.userId || req.user.id;
        const { receiver_id, message } = req.body;

        // Validation
        if (!receiver_id || !message) {
            return res.status(400).json({ message: 'receiver_id and message are required' });
        }

        if (message.trim().length === 0) {
            return res.status(400).json({ message: 'Message cannot be empty' });
        }

        if (message.length > 2000) {
            return res.status(400).json({ message: 'Message too long (max 2000 characters)' });
        }

        // Verify receiver exists
        const receiverCheck = await pool.query('SELECT id FROM users WHERE id = $1', [receiver_id]);
        if (receiverCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Receiver not found' });
        }

        // Insert message
        const result = await pool.query(
            `INSERT INTO messages (sender_id, receiver_id, message, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING id, sender_id, receiver_id, message, read, created_at`,
            [senderId, receiver_id, message.trim()]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error sending message:', err);
        res.status(500).json({ message: 'Server error sending message' });
    }
});

// ─── GET /api/messages/conversation/:userId ──────────────────────────────────
// Get all messages in a conversation with a specific user
router.get('/conversation/:userId', authenticateToken, async (req, res) => {
    try {
        const currentUserId = req.user.userId || req.user.id;
        const otherUserId = parseInt(req.params.userId, 10);

        if (isNaN(otherUserId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        // Get all messages between current user and other user
        const result = await pool.query(
            `SELECT 
        m.id,
        m.sender_id,
        m.receiver_id,
        m.message,
        m.read,
        m.created_at,
        u.name as sender_name,
        CASE WHEN m.sender_id = $1 THEN true ELSE false END as is_mine
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE (m.sender_id = $1 AND m.receiver_id = $2)
          OR (m.sender_id = $2 AND m.receiver_id = $1)
       ORDER BY m.created_at ASC`,
            [currentUserId, otherUserId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching conversation:', err);
        res.status(500).json({ message: 'Server error fetching conversation' });
    }
});

// ─── GET /api/messages/conversations ─────────────────────────────────────────
// Get list of all conversations (for owner)
router.get('/conversations', authenticateToken, async (req, res) => {
    try {
        const currentUserId = req.user.userId || req.user.id;

        // Get all users who have messages with current user
        const result = await pool.query(
            `SELECT DISTINCT
        u.id as user_id,
        u.name as user_name,
        u.email as user_email,
        (
          SELECT m2.message
          FROM messages m2
          WHERE (m2.sender_id = u.id AND m2.receiver_id = $1)
             OR (m2.sender_id = $1 AND m2.receiver_id = u.id)
          ORDER BY m2.created_at DESC
          LIMIT 1
        ) as last_message,
        (
          SELECT m2.created_at
          FROM messages m2
          WHERE (m2.sender_id = u.id AND m2.receiver_id = $1)
             OR (m2.sender_id = $1 AND m2.receiver_id = u.id)
          ORDER BY m2.created_at DESC
          LIMIT 1
        ) as last_message_time,
        (
          SELECT COUNT(*)
          FROM messages m2
          WHERE m2.sender_id = u.id 
            AND m2.receiver_id = $1 
            AND m2.read = false
        ) as unread_count,
        (
          SELECT CASE WHEN m2.sender_id = $1 THEN true ELSE false END
          FROM messages m2
          WHERE (m2.sender_id = u.id AND m2.receiver_id = $1)
             OR (m2.sender_id = $1 AND m2.receiver_id = u.id)
          ORDER BY m2.created_at DESC
          LIMIT 1
        ) as is_last_message_mine
       FROM users u
       WHERE EXISTS (
         SELECT 1 FROM messages m
         WHERE (m.sender_id = u.id AND m.receiver_id = $1)
            OR (m.sender_id = $1 AND m.receiver_id = u.id)
       )
       ORDER BY last_message_time DESC`,
            [currentUserId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching conversations:', err);
        res.status(500).json({ message: 'Server error fetching conversations' });
    }
});

// ─── PATCH /api/messages/conversation/:userId/read ───────────────────────────
// Mark all messages in a conversation as read
router.patch('/conversation/:userId/read', authenticateToken, async (req, res) => {
    try {
        const currentUserId = req.user.userId || req.user.id;
        const otherUserId = parseInt(req.params.userId, 10);

        if (isNaN(otherUserId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        // Mark all messages from other user as read
        const result = await pool.query(
            `UPDATE messages 
       SET read = true, updated_at = NOW()
       WHERE sender_id = $1 
         AND receiver_id = $2 
         AND read = false
       RETURNING id`,
            [otherUserId, currentUserId]
        );

        res.json({
            success: true,
            marked_count: result.rows.length
        });
    } catch (err) {
        console.error('Error marking messages as read:', err);
        res.status(500).json({ message: 'Server error marking messages as read' });
    }
});

// ─── GET /api/messages/unread-count ──────────────────────────────────────────
// Get total unread message count
router.get('/unread-count', authenticateToken, async (req, res) => {
    try {
        const currentUserId = req.user.userId || req.user.id;

        const result = await pool.query(
            `SELECT COUNT(*) as count
       FROM messages
       WHERE receiver_id = $1 AND read = false`,
            [currentUserId]
        );

        res.json({
            count: parseInt(result.rows[0].count, 10)
        });
    } catch (err) {
        console.error('Error fetching unread count:', err);
        res.status(500).json({ message: 'Server error fetching unread count' });
    }
});

// ─── GET /api/messages/owner ─────────────────────────────────────────────────
// Get owner user ID (helper endpoint for employees)
router.get('/owner', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, email 
       FROM users 
       WHERE role = 'owner' OR role = 'admin'
       ORDER BY role DESC
       LIMIT 1`
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'No owner found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching owner:', err);
        res.status(500).json({ message: 'Server error fetching owner' });
    }
});

module.exports = router;
