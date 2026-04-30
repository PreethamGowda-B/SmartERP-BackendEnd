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

// ─── GET /api/notifications/unread-count ─────────────────────────────────────
// ⚠️  Must come BEFORE /sse so Express doesn't treat "unread-count" as the SSE path
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

// ─── GET /api/notifications/sse ──────────────────────────────────────────────
// C4 FIX: Each SSE connection now subscribes to its own Redis channel
// (`employee_notifications:{userId}`) so events work across cluster workers.
// Falls back to in-process Map when Redis is unavailable (dev/single-worker).
router.get('/sse', authenticateToken, (req, res) => {
  const userId = String(req.user.userId || req.user.id);
  const redisUrl = process.env.REDIS_URL;

  console.log(`📡 SSE connection established for user ${userId}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'SSE connection established' })}\n\n`);

  const heartbeatInterval = setInterval(() => {
    try { res.write(`:heartbeat\n\n`); }
    catch { clearInterval(heartbeatInterval); }
  }, 15000);

  // ── Redis path (cluster-safe) ─────────────────────────────────────────────
  if (redisUrl) {
    const Redis = require('ioredis');
    let subscriber;
    try {
      subscriber = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy(times) { return times > 3 ? null : Math.min(times * 200, 1000); },
        lazyConnect: false,
      });
    } catch (redisErr) {
      console.warn('SSE: Redis subscriber creation failed, using in-process fallback:', redisErr.message);
      subscriber = null;
    }

    if (subscriber) {
      const channel = `employee_notifications:${userId}`;

      subscriber.subscribe(channel, (err) => {
        if (err) {
          console.error('SSE Redis subscribe error:', err.message);
          subscriber.disconnect();
          // Fall through to in-process fallback below
          registerSSEConnection(userId, res);
        }
      });

      subscriber.on('message', (ch, rawMessage) => {
        if (ch === channel) {
          try { res.write(`data: ${rawMessage}\n\n`); }
          catch (writeErr) { console.error('SSE write error:', writeErr.message); }
        }
      });

      subscriber.on('error', (err) => {
        console.warn('SSE Redis subscriber error (non-fatal):', err.message);
      });

      req.on('close', () => {
        console.log(`📡 SSE connection closed for user ${userId}`);
        clearInterval(heartbeatInterval);
        try { subscriber.unsubscribe(channel); subscriber.disconnect(); } catch {}
      });

      return; // Keep connection open — cleanup handled by req.on('close')
    }
  }

  // ── In-process fallback (dev / no Redis) ─────────────────────────────────
  registerSSEConnection(userId, res);
  req.on('close', () => {
    console.log(`📡 SSE connection closed for user ${userId}`);
    clearInterval(heartbeatInterval);
    unregisterSSEConnection(userId, res);
  });
});

// ─── PATCH /api/notifications/mark-all-read ──────────────────────────────────
// ⚠️  Must come BEFORE /:id/read so Express doesn't treat "mark-all-read" as an :id param
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

// ─── POST /api/notifications/devices ────────────────────────────────────────
// Register/Update a device token for the current user
router.post('/devices', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { fcmToken, deviceType } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ message: 'Token is required' });
    }

    // Upsert the token
    await pool.query(
      `INSERT INTO user_devices (user_id, fcm_token, device_type, last_seen)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (fcm_token) 
       DO UPDATE SET user_id = $1, device_type = $3, last_seen = NOW()`,
      [userId, fcmToken, deviceType || 'unknown']
    );

    res.json({ ok: true, message: 'Device registered successfully' });
  } catch (err) {
    console.error('❌ Error registering device:', err);
    res.status(500).json({ message: 'Server error registering device' });
  }
});

module.exports = router;
