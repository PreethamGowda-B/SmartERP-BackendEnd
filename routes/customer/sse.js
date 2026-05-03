/**
 * routes/customer/sse.js
 *
 * Server-Sent Events endpoint for real-time customer job updates.
 *
 *   GET /jobs/:id/events — SSE stream for a specific job
 *
 * Auth: JWT via customer_access_token HttpOnly cookie (primary).
 *       ?token= query param accepted ONLY as fallback when cookie is absent
 *       (EventSource cannot set custom headers in some environments).
 *       Token is validated strictly — invalid/expired tokens are rejected.
 *
 * Redis pub/sub channel: customer_job_events:{jobId}
 * This makes SSE cluster-safe — events published by any worker reach all subscribers.
 *
 * Fallback: if Redis is unavailable, sends 'connected' event then closes after 30s,
 * prompting the client to reconnect and re-fetch job state.
 */

const express = require('express');
const router = express.Router();
const Redis = require('ioredis');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');

// ─── Shared Redis subscriber (one connection for all SSE clients) ─────────────
// Creating one ioredis connection per SSE client exhausts Redis connection limits
// at scale. Instead we use a single shared subscriber and a local listener map.
let sharedSubscriber = null;
// Map<channel, Set<(message: string) => void>>
const channelListeners = new Map();

function getSharedSubscriber() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  if (sharedSubscriber && sharedSubscriber.status === 'ready') {
    return sharedSubscriber;
  }

  try {
    sharedSubscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 300, 3000);
      },
      lazyConnect: false,
    });

    sharedSubscriber.on('message', (channel, message) => {
      const listeners = channelListeners.get(channel);
      if (listeners) {
        listeners.forEach(fn => {
          try { fn(message); } catch {}
        });
      }
    });

    sharedSubscriber.on('error', (err) => {
      console.warn('SSE shared subscriber error:', err.message);
    });
  } catch (err) {
    console.warn('SSE: Failed to create shared Redis subscriber:', err.message);
    sharedSubscriber = null;
  }

  return sharedSubscriber;
}

function addChannelListener(channel, fn) {
  if (!channelListeners.has(channel)) {
    channelListeners.set(channel, new Set());
    // Subscribe only when first listener is added
    const sub = getSharedSubscriber();
    if (sub) sub.subscribe(channel).catch(e => console.warn('SSE subscribe error:', e.message));
  }
  channelListeners.get(channel).add(fn);
}

function removeChannelListener(channel, fn) {
  const listeners = channelListeners.get(channel);
  if (!listeners) return;
  listeners.delete(fn);
  if (listeners.size === 0) {
    channelListeners.delete(channel);
    // Unsubscribe when no more listeners
    const sub = sharedSubscriber;
    if (sub && sub.status === 'ready') {
      sub.unsubscribe(channel).catch(e => console.warn('SSE unsubscribe error:', e.message));
    }
  }
}

// ─── Inline SSE auth — cookie-first, query token only as fallback ─────────────
// We do NOT use the shared middleware here because SSE connections
// may arrive before the cookie is set in some browser environments.
function authenticateSSE(req, res, next) {
  let token = null;

  // 1. Primary: HttpOnly cookies (check both customer and user/employee)
  if (req.cookies) {
    token = req.cookies.customer_access_token || 
            req.cookies.user_access_token || 
            req.cookies.access_token || 
            req.cookies.business_access_token ||
            req.cookies.superadmin_access_token;
  }

  // 2. Fallback: ?token= query param (if cookie absent OR cookie fails later, though we only take one here)
  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  // Query token is a true fallback only — do NOT override a valid cookie token
  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    if (payload.role !== 'customer' && payload.role !== 'employee' && payload.role !== 'owner' && payload.role !== 'admin' && payload.role !== 'super_admin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    req.user = payload;
    next();
  });
}

// ─── GET /jobs/:id/events ─────────────────────────────────────────────────────
router.get('/jobs/:id/events', authenticateSSE, async (req, res) => {
  const userId = req.user.id || req.user.userId;
  const companyId = req.user.companyId;
  const role = req.user.role;
  const { id: jobId } = req.params;

  // Verify job ownership / assignment before opening the stream
  try {
    let jobCheck;
    if (role === 'customer') {
      jobCheck = await pool.query(
        `SELECT id FROM jobs WHERE id = $1 AND customer_id = $2 AND company_id = $3`,
        [jobId, userId, companyId]
      );
    } else if (role === 'employee') {
      jobCheck = await pool.query(
        `SELECT id FROM jobs WHERE id = $1 AND assigned_to = $2 AND company_id::text = $3`,
        [jobId, userId, String(companyId)]
      );
    } else {
      // owner / admin can view any
      jobCheck = await pool.query(
        `SELECT id FROM jobs WHERE id = $1 AND company_id::text = $2`,
        [jobId, String(companyId)]
      );
    }

    if (jobCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }
  } catch (err) {
    console.error('SSE ownership check error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }

  // Set SSE headers (Requirement 11.1)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial connected event (Requirement 11.2)
  res.write(`data: ${JSON.stringify({ type: 'connected', jobId })}\n\n`);

  // Keep-alive ping every 25 seconds to prevent proxy timeouts
  const keepAliveInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAliveInterval);
    }
  }, 25_000);

  // ── Redis pub/sub path ──────────────────────────────────────────────────────
  const subscriber = getSharedSubscriber();

  if (subscriber) {
    const channel = `customer_job_events:${jobId}`;

    const messageHandler = (message) => {
      try {
        res.write(`data: ${message}\n\n`);
      } catch (writeErr) {
        console.error('SSE write error:', writeErr.message);
      }
    };

    addChannelListener(channel, messageHandler);

    // Cleanup on client disconnect (Requirement 11.8)
    req.on('close', () => {
      clearInterval(keepAliveInterval);
      removeChannelListener(channel, messageHandler);
      console.log(`SSE connection closed for job ${jobId}, user ${userId}`);
    });

    return; // Keep connection open — cleanup handled by req.on('close')
  }

  // ── Fallback: no Redis — close after 30s, client will reconnect ────────────
  function startFallbackTimeout() {
    const fallbackTimeout = setTimeout(() => {
      clearInterval(keepAliveInterval);
      try {
        res.write(`data: ${JSON.stringify({ type: 'reconnect', reason: 'realtime_unavailable' })}\n\n`);
        res.end();
      } catch {
        // Connection already closed
      }
    }, 30_000);

    req.on('close', () => {
      clearInterval(keepAliveInterval);
      clearTimeout(fallbackTimeout);
    });
  }

  startFallbackTimeout();
});

module.exports = router;
