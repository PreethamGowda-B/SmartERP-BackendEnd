const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification, broadcastToUser } = require('../utils/notificationHelpers');
const { loadPlan } = require('../middleware/planMiddleware');
const redisClient = require('../utils/redis');

// Global protection: authentication + plan loading required for all message routes.
// Note: messages is available on all plans — no requireFeature gate here.
// Individual endpoints that need plan data (e.g. history_days) read from req.plan directly.
router.use(authenticateToken, loadPlan);

// ─── GET /api/messages/contacts ──────────────────────────────────────────────
// Get all users in the same company (excluding current user) with online status
router.get('/contacts', async (req, res) => {
  try {
    const currentUserId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    // Fetch all company users except the current user
    const result = await pool.query(
      `SELECT id AS user_id, name, role
       FROM users
       WHERE company_id::text = $1
         AND id::text != $2
       ORDER BY role, name`,
      [String(companyId), String(currentUserId)]
    );

    const users = result.rows;

    // Enrich each user with online status from Redis
    const redisKey = `online_users:${companyId}`;
    const usersWithStatus = await Promise.all(
      users.map(async (user) => {
        let online_status = false;
        try {
          if (redisClient && redisClient.status === 'ready') {
            const val = await redisClient.hget(redisKey, String(user.user_id));
            online_status = val !== null && val !== '0';
          }
        } catch (redisErr) {
          // Redis failure — fall back to false (already set above)
          console.warn('⚠️ Redis hget failed for contacts online status:', redisErr.message);
        }
        return { ...user, online_status };
      })
    );

    res.json(usersWithStatus);
  } catch (err) {
    console.error('Error fetching contacts:', err);
    res.status(500).json({ message: 'Server error fetching contacts' });
  }
});

// ─── POST /api/messages/conversations/start ──────────────────────────────────
// Get-or-create a 1:1 conversation between current user and other_user_id
router.post('/conversations/start', async (req, res) => {
  try {
    const currentUserId = req.user.userId || req.user.id;
    const { other_user_id } = req.body;

    // Validate input
    if (!other_user_id) {
      return res.status(400).json({ message: 'other_user_id is required' });
    }

    // Verify both users belong to the same company
    const companyCheck = await pool.query(
      `SELECT u1.company_id AS c1, u2.company_id AS c2
       FROM users u1, users u2
       WHERE u1.id::text = $1 AND u2.id::text = $2`,
      [String(currentUserId), String(other_user_id)]
    );

    if (companyCheck.rows.length === 0) {
      return res.status(403).json({ message: 'One or both users not found' });
    }

    const { c1, c2 } = companyCheck.rows[0];
    if (String(c1) !== String(c2)) {
      return res.status(403).json({ message: 'Users do not belong to the same company' });
    }

    const companyId = c1;

    // Check if a conversation already exists between the two users
    const existing = await pool.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id::text = $1
       JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id::text = $2
       WHERE c.company_id::text = $3
       LIMIT 1`,
      [String(currentUserId), String(other_user_id), String(companyId)]
    );

    if (existing.rows.length > 0) {
      return res.json({ conversation_id: existing.rows[0].id, created: false });
    }

    // No existing conversation — create one in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const convResult = await client.query(
        `INSERT INTO conversations (company_id) VALUES ($1) RETURNING id`,
        [companyId]
      );
      const newConversationId = convResult.rows[0].id;

      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1,$2),($1,$3)`,
        [newConversationId, currentUserId, other_user_id]
      );

      await client.query('COMMIT');

      return res.status(201).json({ conversation_id: newConversationId, created: true });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error starting conversation:', err);
    res.status(500).json({ message: 'Server error starting conversation' });
  }
});

// ─── POST /api/messages ───────────────────────────────────────────────────────
// Send a new message in a conversation
router.post('/', async (req, res) => {
  try {
    const senderId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    // Accept conversation_id + content (new model), fall back to legacy message field
    const {
      conversation_id,
      content,
      message: legacyMessage  // legacy fallback
    } = req.body;

    const msgContent = content ?? legacyMessage;

    // Validation
    if (!conversation_id) {
      return res.status(400).json({ message: 'conversation_id is required' });
    }
    if (!msgContent || String(msgContent).trim().length === 0) {
      return res.status(400).json({ message: 'content cannot be empty' });
    }
    if (String(msgContent).length > 2000) {
      return res.status(400).json({ message: 'Message too long (max 2000 characters)' });
    }

    // Verify requester is a participant of the conversation
    const participantCheck = await pool.query(
      `SELECT id FROM conversation_participants WHERE conversation_id = $1 AND user_id::text = $2`,
      [conversation_id, String(senderId)]
    );
    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied — you are not a participant in this conversation' });
    }

    // Get the other participant's user_id
    const otherParticipantResult = await pool.query(
      `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id::text != $2`,
      [conversation_id, String(senderId)]
    );
    const recipientId = otherParticipantResult.rows[0]?.user_id ?? null;

    const trimmedContent = String(msgContent).trim();

    // Insert message
    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, company_id, content, message, message_type, created_at, updated_at)
       VALUES ($1, $2::UUID, $3::UUID, $4, $4, 'text', NOW(), NOW())
       RETURNING id, conversation_id, sender_id, content, message_type, created_at`,
      [conversation_id, String(senderId), String(companyId), trimmedContent]
    );

    const sentMessage = result.rows[0];

    // Update conversation's updated_at
    await pool.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
      [conversation_id]
    );

    // Get sender info for notifications
    let senderName = 'User';
    let senderRole = 'employee';
    try {
      const senderInfo = await pool.query(
        `SELECT name, role FROM users WHERE id::text = $1`,
        [String(senderId)]
      );
      senderName = senderInfo.rows[0]?.name ?? 'User';
      senderRole = senderInfo.rows[0]?.role ?? 'employee';
    } catch (infoErr) {
      console.warn('⚠️ Could not fetch sender info:', infoErr.message);
    }

    // Broadcast real-time SSE event to recipient
    if (recipientId) {
      try {
        broadcastToUser(recipientId, {
          type: 'new_message',
          data: {
            conversation_id,
            message_id: sentMessage.id,
            sender_id: senderId,
            sender_name: senderName,
            content: trimmedContent,
            message_type: 'text',
            created_at: sentMessage.created_at
          }
        });
      } catch (broadcastErr) {
        console.warn('⚠️ broadcastToUser failed:', broadcastErr.message);
      }

      // Push notification to recipient
      try {
        const recipientInfo = await pool.query(
          `SELECT role FROM users WHERE id::text = $1`,
          [String(recipientId)]
        );
        const recipientRole = recipientInfo.rows[0]?.role ?? 'employee';
        const targetUrl = recipientRole === 'owner' || recipientRole === 'admin'
          ? '/owner/messages'
          : '/employee/messages';

        await createNotification({
          user_id: recipientId,
          company_id: companyId,
          type: 'message',
          title: 'New Message',
          message: `New message from ${senderName}`,
          priority: senderRole === 'owner' ? 'high' : 'medium',
          actor_id: senderId,
          data: {
            message_id: sentMessage.id,
            sender_id: senderId,
            conversation_id,
            url: targetUrl
          }
        });
      } catch (notifErr) {
        console.error('❌ Failed to send message notification:', notifErr);
      }
    }

    res.status(201).json({
      id: sentMessage.id,
      conversation_id: sentMessage.conversation_id,
      sender_id: sentMessage.sender_id,
      sender_name: senderName,
      content: sentMessage.content,
      message_type: sentMessage.message_type,
      created_at: sentMessage.created_at,
      is_mine: true
    });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ message: 'Server error sending message' });
  }
});

// ─── GET /api/messages/conversation/:conversationId ──────────────────────────
// Get paginated messages in a conversation (newest-first, page size 50)
router.get('/conversation/:conversationId', async (req, res) => {
  try {
    const currentUserId = req.user.userId || req.user.id;
    const { conversationId } = req.params;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = 50;
    const offset = (page - 1) * pageSize;
    const historyDays = req.plan?.messages_history_days ?? 30;

    // Verify requester is a participant
    const participantCheck = await pool.query(
      `SELECT id FROM conversation_participants WHERE conversation_id = $1 AND user_id::text = $2`,
      [conversationId, String(currentUserId)]
    );
    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied — you are not a participant in this conversation' });
    }

    // Fetch one extra row to determine has_more
    const result = await pool.query(
      `SELECT m.id, m.conversation_id, m.sender_id, u.name AS sender_name,
              COALESCE(m.content, m.message) AS content,
              COALESCE(m.message_type, 'text') AS message_type,
              m.created_at,
              CASE WHEN m.sender_id::text = $1 THEN true ELSE false END AS is_mine
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $2
         AND m.created_at >= NOW() - ($3 * INTERVAL '1 day')
       ORDER BY m.created_at DESC
       LIMIT 51 OFFSET $4`,
      [String(currentUserId), conversationId, historyDays, offset]
    );

    const fetched = result.rows;
    const hasMore = fetched.length > pageSize;
    const messages = hasMore ? fetched.slice(0, pageSize) : fetched;

    res.json({ messages, has_more: hasMore });
  } catch (err) {
    console.error('Error fetching conversation:', err);
    res.status(500).json({ message: 'Server error fetching conversation' });
  }
});

// ─── GET /api/messages/conversations ─────────────────────────────────────────
// Get list of all conversations for the current user — conversation-model-based
router.get('/conversations', async (req, res) => {
  try {
    const currentUserId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    const result = await pool.query(
      `SELECT
        c.id AS conversation_id,
        other_u.id AS other_user_id,
        other_u.name AS other_user_name,
        other_u.role AS other_user_role,
        LEFT(COALESCE(last_msg.content, last_msg.message), 80) AS last_message,
        last_msg.created_at AS last_message_time,
        CASE WHEN last_msg.sender_id::text = $1 THEN true ELSE false END AS is_last_message_mine,
        COALESCE((
          SELECT COUNT(*)
          FROM messages m2
          WHERE m2.conversation_id = c.id
            AND m2.sender_id::text != $1
            AND (my_cp.last_read_at IS NULL OR m2.created_at > my_cp.last_read_at)
        ), 0) AS unread_count,
        c.updated_at
      FROM conversations c
      JOIN conversation_participants my_cp ON my_cp.conversation_id = c.id AND my_cp.user_id::text = $1
      JOIN conversation_participants other_cp ON other_cp.conversation_id = c.id AND other_cp.user_id::text != $1
      JOIN users other_u ON other_u.id = other_cp.user_id
      LEFT JOIN LATERAL (
        SELECT content, message, sender_id, created_at
        FROM messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC
        LIMIT 1
      ) last_msg ON true
      WHERE c.company_id::text = $2
      ORDER BY c.updated_at DESC NULLS LAST`,
      [String(currentUserId), String(companyId)]
    );

    const redisKey = `online_users:${companyId}`;
    const rows = await Promise.all(
      result.rows.map(async (row) => {
        let other_user_online = false;
        try {
          if (redisClient && redisClient.status === 'ready') {
            const val = await redisClient.hget(redisKey, String(row.other_user_id));
            other_user_online = val !== null && val !== '0';
          }
        } catch (redisErr) {
          console.warn('⚠️ Redis hget failed for conversations online status:', redisErr.message);
        }
        return {
          conversation_id: row.conversation_id,
          other_user_id: row.other_user_id,
          other_user_name: row.other_user_name,
          other_user_role: row.other_user_role,
          last_message: row.last_message ?? null,
          last_message_time: row.last_message_time ? new Date(row.last_message_time).toISOString() : null,
          unread_count: parseInt(row.unread_count, 10),
          is_last_message_mine: row.is_last_message_mine ?? false,
          other_user_online,
        };
      })
    );

    res.json(rows);
  } catch (err) {
    console.error('Error fetching conversations:', err);
    res.status(500).json({ message: 'Server error fetching conversations' });
  }
});

// ─── PATCH /api/messages/conversation/:conversationId/read ───────────────────
// Mark conversation as read for the current user via last_read_at
router.patch('/conversation/:conversationId/read', async (req, res) => {
  try {
    const currentUserId = req.user.userId || req.user.id;
    const { conversationId } = req.params;

    // Verify participant membership
    const participantCheck = await pool.query(
      `SELECT id FROM conversation_participants WHERE conversation_id = $1 AND user_id::text = $2`,
      [conversationId, String(currentUserId)]
    );
    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied — you are not a participant in this conversation' });
    }

    await pool.query(
      `UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id::text = $2`,
      [conversationId, String(currentUserId)]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error marking conversation as read:', err);
    res.status(500).json({ message: 'Server error marking conversation as read' });
  }
});

// ─── GET /api/messages/unread-count ──────────────────────────────────────────
// Get total unread message count across all conversations — conversation-model-based
router.get('/unread-count', async (req, res) => {
  try {
    const currentUserId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    const result = await pool.query(
      `SELECT COALESCE(SUM(sub.cnt), 0) AS count
       FROM (
         SELECT COUNT(*) AS cnt
         FROM conversations c
         JOIN conversation_participants my_cp ON my_cp.conversation_id = c.id AND my_cp.user_id::text = $1
         WHERE c.company_id::text = $2
           AND EXISTS (
             SELECT 1 FROM messages m
             WHERE m.conversation_id = c.id
               AND m.sender_id::text != $1
               AND (my_cp.last_read_at IS NULL OR m.created_at > my_cp.last_read_at)
           )
       ) sub`,
      [String(currentUserId), String(companyId)]
    );

    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (err) {
    console.error('Error fetching unread count:', err);
    res.status(500).json({ message: 'Server error fetching unread count' });
  }
});

// ─── GET /api/messages/search ─────────────────────────────────────────────────
// Search messages within a conversation using ILIKE
router.get('/search', async (req, res) => {
  try {
    const currentUserId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;
    const { q, conversationId } = req.query;

    // Validate required params
    if (!conversationId) {
      return res.status(400).json({ message: 'conversationId is required' });
    }
    if (!q || String(q).trim().length < 2) {
      return res.status(400).json({ message: 'q must be at least 2 characters' });
    }

    // Verify requester is a participant
    const participantCheck = await pool.query(
      `SELECT id FROM conversation_participants WHERE conversation_id = $1 AND user_id::text = $2`,
      [conversationId, String(currentUserId)]
    );
    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied — you are not a participant in this conversation' });
    }

    const searchPattern = `%${q.trim()}%`;

    const result = await pool.query(
      `SELECT m.id, m.conversation_id, m.sender_id, u.name AS sender_name,
              COALESCE(m.content, m.message) AS content,
              m.created_at,
              CASE WHEN m.sender_id::text = $1 THEN true ELSE false END AS is_mine
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $2
         AND m.company_id::text = $3
         AND COALESCE(m.content, m.message) ILIKE $4
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [String(currentUserId), conversationId, String(companyId), searchPattern]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error searching messages:', err);
    res.status(500).json({ message: 'Server error searching messages' });
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


// ─── GET /api/messages/job/:jobId ─────────────────────────────────────────────
// Get full message history for a specific job (employee side)
router.get('/job/:jobId', async (req, res) => {
  try {
    const employeeId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;
    const { jobId } = req.params;

    // Verify employee is assigned to this job
    const jobCheck = await pool.query(
      'SELECT id FROM jobs WHERE id = $1 AND assigned_to::text = $2 AND company_id::text = $3',
      [jobId, String(employeeId), String(companyId)]
    );
    if (jobCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT id, sender_type, sender_id, sender_name, message, read_by_employee, read_by_customer, created_at
       FROM job_messages
       WHERE job_id = $1
       ORDER BY created_at ASC
       LIMIT 200`,
      [jobId]
    );

    // Mark customer messages as read by employee
    pool.query(
      `UPDATE job_messages SET read_by_employee = TRUE
       WHERE job_id = $1 AND sender_type = 'customer' AND read_by_employee = FALSE`,
      [jobId]
    ).catch(() => {});

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
    const companyId = req.user.companyId;
    const { jobId } = req.params;
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

    const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i.test(String(companyId));
    const safeCompanyId = isUUID ? String(companyId) : null;

    // Insert message
    const result = await pool.query(
      `INSERT INTO job_messages (job_id, sender_type, sender_id, sender_name, message, company_id, read_by_employee, read_by_customer)
       VALUES ($1, 'employee', $2, $3, $4, $5, TRUE, FALSE)
       RETURNING id, sender_type, sender_id, sender_name, message, read_by_employee, read_by_customer, created_at`,
      [jobId, String(employeeId), senderName, message.trim(), safeCompanyId]
    );

    const newMessage = result.rows[0];

    // Publish SSE to customer portal
    try {
      const redisClient = require('../utils/redis');
      if (redisClient && redisClient.status === 'ready') {
        redisClient.publish(
          `customer_job_events:${jobId}`,
          JSON.stringify({ type: 'chat_message', jobId, message: newMessage })
        ).catch(() => { });
      }
    } catch { }

    // Notify customer (NOT the employee sender)
    try {
      if (job.customer_id) {
        const { createNotification } = require('../utils/notificationHelpers');
        await createNotification({
          user_id: job.customer_id,
          company_id: String(companyId),
          type: 'chat_message',
          title: 'New Message from Technician',
          message: `${senderName}: ${message.trim().substring(0, 60)}${message.length > 60 ? '…' : ''}`,
          priority: 'medium',
          actor_id: employeeId,
          idempotency_key: `chat_emp_${newMessage.id}`,
          data: { job_id: jobId, url: `/customer/job/${jobId}` }
        });
      }
    } catch { }

    res.status(201).json(newMessage);
  } catch (err) {
    console.error('Error sending job message:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/messages/job-conversations ─────────────────────────────────────
// Employee: returns list of all job conversations where they are assigned_to
// Each item includes last_message, unread_count, customer name
router.get('/job-conversations', async (req, res) => {
  try {
    const employeeId = req.user.userId || req.user.id;
    const companyId = req.user.companyId;

    const result = await pool.query(
      `SELECT
          j.id              AS job_id,
          j.title           AS job_title,
          j.status          AS job_status,
          j.employee_status,
          j.customer_id,
          c.name            AS customer_name,
          c.email           AS customer_email,
          MAX(jm.created_at) AS last_message_time,
          (SELECT message FROM job_messages jm2
            WHERE jm2.job_id = j.id
            ORDER BY jm2.created_at DESC LIMIT 1) AS last_message,
          COUNT(DISTINCT jm.id)      AS total_messages,
          -- Unread count: messages from customer that this employee hasn't read
          COUNT(DISTINCT jm_unread.id) AS unread_count
       FROM jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       LEFT JOIN job_messages jm ON jm.job_id = j.id
       LEFT JOIN job_messages jm_unread ON (
             jm_unread.job_id = j.id
         AND jm_unread.sender_type = 'customer'
         AND jm_unread.read_by_employee = false
       )
       WHERE j.assigned_to::text = $1
         AND j.company_id::text = $2
         AND j.customer_id IS NOT NULL
       GROUP BY j.id, j.title, j.status, j.employee_status, j.customer_id,
                c.name, c.email
       ORDER BY last_message_time DESC NULLS LAST`,
      [String(employeeId), String(companyId)]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('GET /messages/job-conversations error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

