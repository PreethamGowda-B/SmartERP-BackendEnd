// cspell:words hset hdel
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { registerSSEConnection, unregisterSSEConnection, broadcastToUser } = require('../utils/notificationHelpers');
const { redisClient } = require('../utils/redis'); // shared singleton — never create extra connections for non-pubsub ops

const INTERNAL_ROLES = new Set(['owner', 'employee', 'hr', 'admin', 'super_admin']);

// Resolve notification authority from the persisted staff record, never from
// request parameters or an unverified role/company claim supplied by a client.
async function requireInternalNotificationPrincipal(req, res, next) {
  try {
    const claimedId = String(req.user?.userId || req.user?.id || '');
    if (!claimedId) return res.status(403).json({ message: 'Internal account required' });
    const result = await pool.query(
      'SELECT id, role, company_id FROM users WHERE id::text = $1::text LIMIT 1',
      [claimedId]
    );
    const principal = result.rows[0];
    if (!principal || !INTERNAL_ROLES.has(String(principal.role || '').toLowerCase())) {
      return res.status(403).json({ message: 'Internal account required' });
    }
    req.notificationPrincipal = {
      id: String(principal.id),
      role: String(principal.role).toLowerCase(),
      companyId: principal.company_id == null ? null : String(principal.company_id),
    };
    next();
  } catch (error) {
    console.error('Notification principal lookup failed:', error.message);
    return res.status(500).json({ message: 'Unable to authorize notification access' });
  }
}

function notificationScope(req) {
  return req.notificationPrincipal;
}

// ─── GET /api/notifications ──────────────────────────────────────────────────
// Get all notifications for authenticated user
router.get('/', authenticateToken, requireInternalNotificationPrincipal, async (req, res) => {
  try {
    const { id: userId, companyId } = notificationScope(req);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const search = String(req.query.search || '').trim().slice(0, 120);

    const result = await pool.query(
      `SELECT * FROM notifications
       WHERE user_id::text = $1::text
         AND (($2::text IS NULL AND company_id IS NULL) OR company_id::text = $2::text)
         AND ($3::text = '' OR title ILIKE '%' || $3 || '%' OR message ILIKE '%' || $3 || '%' OR type ILIKE '%' || $3 || '%')
       ORDER BY created_at DESC 
       LIMIT $4 OFFSET $5`,
      [userId, companyId, search, limit, offset]
    );

    res.json(result.rows || []);
  } catch (err) {
    console.error('❌ Error fetching notifications:', err);
    res.status(500).json({ message: 'Unable to fetch notifications' });
  }
});

// ─── GET /api/notifications/unread-count ─────────────────────────────────────
// ⚠️  Must come BEFORE /sse so Express doesn't treat "unread-count" as the SSE path
router.get('/unread-count', authenticateToken, requireInternalNotificationPrincipal, async (req, res) => {
  try {
    const { id: userId, companyId } = notificationScope(req);

    const result = await pool.query(
      `SELECT COUNT(*) as count 
       FROM notifications 
       WHERE user_id::text = $1::text
         AND (($2::text IS NULL AND company_id IS NULL) OR company_id::text = $2::text)
         AND read = FALSE`,
      [userId, companyId]
    );

    res.json({ count: parseInt(result.rows[0]?.count || 0) });
  } catch (err) {
    console.error('❌ Error getting unread count:', err);
    res.json({ count: 0 });
  }
});


// ─── GET /api/notifications/sse ──────────────────────────────────────────────
// C4 FIX: Each SSE connection now subscribes to its own Redis channel
// (`employee_notifications:{userId}`) so events work across cluster workers.
// Falls back to in-process Map when Redis is unavailable (dev/single-worker).
router.get('/sse', authenticateToken, requireInternalNotificationPrincipal, async (req, res) => {
  const { id: userId, companyId: authorizedCompanyId } = notificationScope(req);
  const redisUrl = process.env.REDIS_URL;

  console.log(`📡 SSE connection established for user ${userId}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'SSE connection established' })}\n\n`);

  // Mark user as online in Redis — reuse shared singleton, no new connection needed
  const companyId = authorizedCompanyId || '';
  if (redisClient && companyId) {
    try {
      const hsetFn = redisClient.hset || redisClient.hSet;
      if (typeof hsetFn === 'function') {
        await hsetFn.call(redisClient, `online_users:${companyId}`, userId, '1');
      }
      if (typeof redisClient.expire === 'function') {
        await redisClient.expire(`online_users:${companyId}`, 300); // 5 min TTL
      }
    } catch (e) {
      console.warn('⚠️ Could not set online status:', e.message);
    }

    // Broadcast status_change (online) to all other users in the same company
    try {
      const peers = await pool.query(
        `SELECT id FROM users WHERE company_id::text = $1 AND id::text != $2
           AND role IN ('owner', 'employee', 'hr', 'admin')`,
        [companyId, userId]
      );
      const payload = { type: 'status_change', data: { user_id: userId, online: true } };
      for (const peer of peers.rows) {
        broadcastToUser(String(peer.id), payload);
      }
    } catch (e) {
      console.warn('⚠️ Could not broadcast status_change (online):', e.message);
    }
  }

  // Active Keep-Alive Ping every 15 seconds to prevent Render / Cloudflare TCP reset
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'ping', timestamp: Date.now() })}\n\n`);
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 15000);

  // ── Redis path (cluster-safe) ─────────────────────────────────────────────
  const { getSharedSubscriber } = require('../utils/redis');
  const subscriber = getSharedSubscriber();

  if (subscriber) {
    registerSSEConnection(userId, res);
    const channel = `employee_notifications:${userId}`;
    if (!global._sseListeners) global._sseListeners = new Map();
    const sseListeners = global._sseListeners;

    if (!sseListeners.has(channel)) {
      sseListeners.set(channel, new Set());
    }
    const listenerSet = sseListeners.get(channel);
    listenerSet.add(res);

    if (!subscriber._handlerAttached) {
      subscriber._handlerAttached = true;
      subscriber.on('message', (ch, rawMessage) => {
        const listeners = global._sseListeners?.get(ch);
        if (listeners) {
          for (const clientRes of listeners) {
            try { clientRes.write(`data: ${rawMessage}\n\n`); }
            catch {}
          }
        }
      });
    }

    if (listenerSet.size === 1) {
      subscriber.subscribe(channel).catch((err) => {
        console.warn('SSE Redis subscribe error:', err.message);
      });
    }

    req.on('close', async () => {
      console.log(`📡 SSE connection closed for user ${userId}`);
      clearInterval(heartbeatInterval);
      unregisterSSEConnection(userId, res);

      listenerSet.delete(res);
      if (listenerSet.size === 0) {
        sseListeners.delete(channel);
        try { subscriber.unsubscribe(channel).catch(() => {}); } catch {}
      }

      // Mark user as offline in Redis — reuse shared singleton
      const companyId = authorizedCompanyId || '';
      if (redisClient && companyId) {
        try {
          await redisClient.hdel(`online_users:${companyId}`, userId);
        } catch (e) {
          console.warn('⚠️ Could not clear online status:', e.message);
        }
      }

      // Broadcast status_change (offline) to all other users in the same company
      try {
        const peers = await pool.query(
          `SELECT id FROM users WHERE company_id::text = $1 AND id::text != $2
             AND role IN ('owner', 'employee', 'hr', 'admin')`,
          [companyId, userId]
        );
        const payload = { type: 'status_change', data: { user_id: userId, online: false } };
        for (const peer of peers.rows) {
          broadcastToUser(String(peer.id), payload);
        }
      } catch (e) {
        console.warn('⚠️ Could not broadcast status_change (offline):', e.message);
      }
    });

    return; // Keep connection open — cleanup handled by req.on('close')
  }

  // ── In-process fallback (dev / no Redis) ─────────────────────────────────
  registerSSEConnection(userId, res);
  req.on('close', () => {
    console.log(`📡 SSE connection closed for user ${userId}`);
    clearInterval(heartbeatInterval);
    unregisterSSEConnection(userId, res);
  });
});

// Detail reads are scoped to the same persisted recipient and company as list reads.
router.get('/:id', authenticateToken, requireInternalNotificationPrincipal, async (req, res) => {
  const { id: userId, companyId } = notificationScope(req);
  try {
    const result = await pool.query(
      `SELECT * FROM notifications
       WHERE id::text = $1::text AND user_id::text = $2::text
         AND (($3::text IS NULL AND company_id IS NULL) OR company_id::text = $3::text)
       LIMIT 1`,
      [req.params.id, userId, companyId]
    );
    if (!result.rows[0]) return res.status(404).json({ message: 'Notification not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error fetching notification detail:', err);
    return res.status(500).json({ message: 'Unable to fetch notification' });
  }
});

// ─── PATCH /api/notifications/mark-all-read ──────────────────────────────────
// ⚠️  Must come BEFORE /:id/read so Express doesn't treat "mark-all-read" as an :id param
router.patch('/mark-all-read', authenticateToken, requireInternalNotificationPrincipal, async (req, res) => {
  try {
    const { id: userId, companyId } = notificationScope(req);

    const result = await pool.query(
      `UPDATE notifications 
       SET read = TRUE 
       WHERE user_id::text = $1::text
         AND (($2::text IS NULL AND company_id IS NULL) OR company_id::text = $2::text)
         AND read = FALSE 
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
router.patch('/:id/read', authenticateToken, requireInternalNotificationPrincipal, async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, companyId } = notificationScope(req);

    const result = await pool.query(
      `UPDATE notifications 
       SET read = TRUE 
       WHERE id::text = $1::text AND user_id::text = $2::text
         AND (($3::text IS NULL AND company_id IS NULL) OR company_id::text = $3::text)
       RETURNING *`,
      [id, userId, companyId]
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
router.post('/devices', authenticateToken, requireInternalNotificationPrincipal, async (req, res) => {
  try {
    const userId = notificationScope(req).id;
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
