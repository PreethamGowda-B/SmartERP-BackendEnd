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

// ─── Inline SSE auth — cookie-first, query token only as fallback ─────────────
// We do NOT use the shared authenticateCustomer middleware here because SSE
// connections may arrive before the cookie is set in some browser environments.
// The query token fallback is strictly validated (same JWT_SECRET, same role check).
function authenticateSSE(req, res, next) {
  let token = null;

  // 1. Primary: HttpOnly cookie
  if (req.cookies && req.cookies.customer_access_token) {
    token = req.cookies.customer_access_token;
  }

  // 2. Fallback: ?token= query param (only if cookie absent)
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
    if (payload.role !== 'customer') {
      return res.status(403).json({ message: 'Access denied' });
    }
    req.customer = payload;
    next();
  });
}

// ─── GET /jobs/:id/events ─────────────────────────────────────────────────────
router.get('/jobs/:id/events', authenticateSSE, async (req, res) => {
  const customerId = req.customer.id;
  const companyId = req.customer.companyId;
  const { id: jobId } = req.params;

  // Verify job ownership before opening the stream (Requirement 11.6)
  try {
    const jobCheck = await pool.query(
      `SELECT id FROM jobs
       WHERE id = $1
         AND customer_id = $2
         AND company_id = $3`,
      [jobId, customerId, companyId]
    );

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
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    // Create a dedicated subscriber client for this connection
    // (ioredis subscribers cannot be used for other commands)
    let subscriber;
    try {
      subscriber = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy(times) {
          if (times > 3) return null;
          return Math.min(times * 200, 1000);
        },
        lazyConnect: false,
      });
    } catch (redisErr) {
      console.warn('SSE: Failed to create Redis subscriber, using fallback:', redisErr.message);
      subscriber = null;
    }

    if (subscriber) {
      const channel = `customer_job_events:${jobId}`;

      subscriber.subscribe(channel, (err) => {
        if (err) {
          console.error('SSE Redis subscribe error:', err.message);
          // Fall through to fallback
          subscriber.disconnect();
          startFallbackTimeout();
        }
      });

      subscriber.on('message', (ch, message) => {
        if (ch === channel) {
          try {
            res.write(`data: ${message}\n\n`);
          } catch (writeErr) {
            console.error('SSE write error:', writeErr.message);
          }
        }
      });

      subscriber.on('error', (err) => {
        console.warn('SSE Redis subscriber error:', err.message);
      });

      // Cleanup on client disconnect (Requirement 11.8)
      req.on('close', () => {
        clearInterval(keepAliveInterval);
        try {
          subscriber.unsubscribe(channel);
          subscriber.disconnect();
        } catch (cleanupErr) {
          console.error('SSE cleanup error:', cleanupErr.message);
        }
        console.log(`SSE connection closed for job ${jobId}, customer ${customerId}`);
      });

      return; // Keep connection open — cleanup handled by req.on('close')
    }
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
