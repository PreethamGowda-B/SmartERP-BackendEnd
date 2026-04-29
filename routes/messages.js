const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification } = require('../utils/notificationHelpers');
const { loadPlan } = require('../middleware/planMiddleware');
const { requireFeature } = require('../middleware/featureGuard');

// Global protection for all message routes
router.use(authenticateToken, loadPlan, requireFeature('messages'));

// ─── POST /api/messages ───────────────────────────────────────────────────────
// Send a new message
router.post('/', async (req, res) => {
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
        const receiverCheck = await pool.query('SELECT id FROM users WHERE id = $1 AND company_id = $2', [receiver_id, req.user.companyId]);
        if (receiverCheck.rows.length === 0) {
            return res.status(403).json({ message: 'Receiver not found or access denied (outside your company)' });
        }

        // Insert message
        const result = await pool.query(
            `INSERT INTO messages (sender_id, receiver_id, message, created_at, updated_at)
       VALUES ($1::UUID, $2::UUID, $3, NOW(), NOW())
       RETURNING id, sender_id, receiver_id, message, read, created_at`,
            [senderId, receiver_id, message.trim()]
        );

        const sentMessage = result.rows[0];

        // Send notification to receiver
        try {
            // Get sender and receiver info
            const usersInfo = await pool.query(
                "SELECT id, name, role FROM users WHERE id::text IN ($1, $2)",
                [String(senderId), String(receiver_id)]
            );

            const sender = usersInfo.rows.find(u => String(u.id) === String(senderId));
            const receiver = usersInfo.rows.find(u => String(u.id) === String(receiver_id));

            const senderName = sender?.name || 'User';
            const senderRole = sender?.role || 'employee';
            const receiverRole = receiver?.role || 'employee';

            // Determine target URL based on receiver's role
            const targetUrl = receiverRole === 'owner' || receiverRole === 'admin'
                ? '/owner/messages'
                : '/employee/messages';

            // Send notification to receiver (both owner->employee and employee->owner)
            await createNotification({
                user_id: receiver_id,
                company_id: req.user.companyId,
                type: 'message',
                title: 'New Message',
                message: `New message from ${senderName}`,
                priority: senderRole === 'owner' ? 'high' : 'medium',
                data: {
                    message_id: sentMessage.id,
                    sender_id: senderId,
                    url: targetUrl
                }
            });
            console.log(`✅ Notification sent for new message to user ${receiver_id} (${targetUrl})`);
        } catch (notifErr) {
            console.error('❌ Failed to send message notification:', notifErr);
        }

        res.status(201).json(sentMessage);
    } catch (err) {
        console.error('Error sending message:', err);
        res.status(500).json({ message: 'Server error sending message' });
    }
});

// ─── GET /api/messages/conversation/:userId ──────────────────────────────────
// Get all messages in a conversation with a specific user
// Message history is filtered by plan's messages_history_days (parameterized - safe from SQL injection)
router.get('/conversation/:userId', async (req, res) => {
    try {
        const currentUserId = req.user.userId || req.user.id;
        const otherUserId = req.params.userId;

        // History cutoff based on plan (9999 days for Pro = effectively unlimited)
        const historyDays = req.plan?.messages_history_days ?? 30;

        if (!otherUserId) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        // Get messages between current user and other user within allowed history window
        // Uses parameterized interval to prevent SQL injection
        const result = await pool.query(
            `SELECT 
        m.id,
        m.sender_id,
        m.receiver_id,
        m.message,
        m.read,
        m.created_at,
        u.name as sender_name,
        CASE WHEN m.sender_id::text = $1::text THEN true ELSE false END as is_mine
       FROM messages m
       JOIN users u ON m.sender_id::text = u.id::text
       WHERE ((m.sender_id::text = $1::text AND m.receiver_id::text = $2::text)
          OR (m.sender_id::text = $2::text AND m.receiver_id::text = $1::text))
         AND m.created_at >= NOW() - ($3 * INTERVAL '1 day')
       ORDER BY m.created_at ASC`,
            [currentUserId, otherUserId, historyDays]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching conversation:', err);
        res.status(500).json({ message: 'Server error fetching conversation' });
    }
});

// ─── GET /api/messages/conversations ─────────────────────────────────────────
// Get list of all conversations (for owner)
router.get('/conversations', async (req, res) => {
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
router.patch('/conversation/:userId/read', async (req, res) => {
    try {
        const currentUserId = req.user.userId || req.user.id;
        const otherUserId = req.params.userId;

        if (!otherUserId) {
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
router.get('/unread-count', async (req, res) => {
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
router.get('/owner', async (req, res) => {
    try {
        const companyId = req.user.companyId;

        console.log(`🔍 Fetching owner for employee ${req.user.userId} (Company: ${companyId})`);

        let result;

        // Strict company isolation: only return owners for the current employee's company
        if (companyId) {
            result = await pool.query(
                `SELECT id, name, email 
                 FROM users 
                 WHERE (role = 'owner' OR role = 'admin') 
                 AND company_id = $1
                 ORDER BY role DESC
                 LIMIT 1`,
                [companyId]
            );
        }

        if (!result || result.rows.length === 0) {
            console.error(`❌ No owner found for company ${companyId}`);
            return res.status(404).json({ message: 'Owner not found' });
        }

        const owner = result.rows[0];
        console.log(`✅ Found owner: ${owner.name} (${owner.id})`);
        res.json(owner);
    } catch (err) {
        console.error('Error fetching owner:', err);
        res.status(500).json({ message: 'Server error fetching owner' });
    }
});

// ─── GET /api/messages/job-conversations ─────────────────────────────────────
// Get all customer job chats where this employee is the assigned technician
// Used by the employee Messages tab to show customer conversations
router.get('/job-conversations', async (req, res) => {
  try {
    const employeeId = req.user.userId || req.user.id;
    const companyId  = req.user.companyId;

    // Find all jobs assigned to this employee that have at least one message
    const result = await pool.query(
      `SELECT
         j.id          AS job_id,
         j.title       AS job_title,
         j.status      AS job_status,
         j.customer_id,
         c.name        AS customer_name,
         c.email       AS customer_email,
         (
           SELECT jm.message
           FROM job_messages jm
           WHERE jm.job_id = j.id
           ORDER BY jm.created_at DESC
           LIMIT 1
         ) AS last_message,
         (
           SELECT jm.created_at
           FROM job_messages jm
           WHERE jm.job_id = j.id
           ORDER BY jm.created_at DESC
           LIMIT 1
         ) AS last_message_time,
         (
           SELECT COUNT(*)
           FROM job_messages jm
           WHERE jm.job_id = j.id
             AND jm.sender_type = 'customer'
         ) AS total_messages
       FROM jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE j.assigned_to::text = $1
         AND j.company_id::text = $2
         AND j.customer_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM job_messages jm WHERE jm.job_id = j.id
         )
       ORDER BY last_message_time DESC NULLS LAST`,
      [String(employeeId), String(companyId)]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching job conversations:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/messages/job/:jobId ─────────────────────────────────────────────
// Get full message history for a specific job (employee side)
router.get('/job/:jobId', async (req, res) => {
  try {
    const employeeId = req.user.userId || req.user.id;
    const companyId  = req.user.companyId;
    const { jobId }  = req.params;

    // Verify employee is assigned to this job
    const jobCheck = await pool.query(
      'SELECT id FROM jobs WHERE id = $1 AND assigned_to::text = $2 AND company_id::text = $3',
      [jobId, String(employeeId), String(companyId)]
    );
    if (jobCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT id, sender_type, sender_id, sender_name, message, created_at
       FROM job_messages
       WHERE job_id = $1
       ORDER BY created_at ASC
       LIMIT 200`,
      [jobId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching job messages:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /api/messages/job/:jobId ────────────────────────────────────────────
// Employee sends a message in a job chat
router.post('/job/:jobId', async (req, res) => {
  try {
    const employeeId = req.user.userId || req.user.id;
    const companyId  = req.user.companyId;
    const { jobId }  = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ message: 'Message cannot be empty' });
    }

    // Verify employee is assigned to this job
    const jobCheck = await pool.query(
      `SELECT j.id, j.customer_id, u.name AS employee_name
       FROM jobs j
       LEFT JOIN users u ON u.id = j.assigned_to
       WHERE j.id = $1 AND j.assigned_to::text = $2 AND j.company_id::text = $3`,
      [jobId, String(employeeId), String(companyId)]
    );
    if (jobCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied — you are not assigned to this job' });
    }

    const job = jobCheck.rows[0];
    const senderName = job.employee_name || 'Technician';

    // Insert message
    const result = await pool.query(
      `INSERT INTO job_messages (job_id, sender_type, sender_id, sender_name, message, company_id)
       VALUES ($1, 'employee', $2, $3, $4, $5)
       RETURNING id, sender_type, sender_id, sender_name, message, created_at`,
      [jobId, String(employeeId), senderName, message.trim(), String(companyId)]
    );

    const newMessage = result.rows[0];

    // Publish SSE to customer portal
    try {
      const redisClient = require('../utils/redis');
      if (redisClient && redisClient.status === 'ready') {
        redisClient.publish(
          `customer_job_events:${jobId}`,
          JSON.stringify({ type: 'chat_message', jobId, message: newMessage })
        ).catch(() => {});
      }
    } catch {}

    res.status(201).json(newMessage);
  } catch (err) {
    console.error('Error sending job message:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
