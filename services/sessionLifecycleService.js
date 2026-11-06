/**
 * services/sessionLifecycleService.js
 *
 * Authoritative Server-Side Session Inactivity & Concurrency Lifecycle Engine.
 *
 * Requirements:
 * 1. Rolling 7-day inactivity timeout (NOT fixed lifetime from original login).
 * 2. Every legitimate authenticated user activity updates last_activity_at.
 * 3. Passive background requests (SSE streams, health checks, background polling)
 *    do NOT extend inactivity timeout.
 * 4. Token refresh rejects sessions inactive for > 7 days and revokes the token family.
 * 5. Concurrency Grace Period (30s) prevents competing simultaneous refresh requests
 *    from triggering false-positive token replay revocations.
 * 6. High-performance throttled database updates (max 1 update per 60s per session).
 */

'use strict';

const INACTIVITY_TIMEOUT_DAYS = 7;
const INACTIVITY_TIMEOUT_MS = INACTIVITY_TIMEOUT_DAYS * 24 * 60 * 60 * 1000; // 604,800,000 ms
const ROTATION_GRACE_PERIOD_MS = 30 * 1000; // 30 seconds
const ACTIVITY_THROTTLE_MS = 60 * 1000; // 1 minute

// In-memory throttle cache when Redis is unavailable
const localActivityThrottle = new Map(); // key -> lastWriteTimestamp (ms)

/**
 * Checks whether a session has exceeded the 7-day rolling inactivity limit.
 *
 * @param {Date|string|number} lastActivityAt - Timestamp of last meaningful user activity
 * @param {Date|string|number} [referenceTime=new Date()] - Evaluation time (UTC)
 * @returns {boolean} True if session is inactive (> 7 days), false if active
 */
function isSessionInactive(lastActivityAt, referenceTime = new Date()) {
  if (!lastActivityAt) return false;

  const lastMs = new Date(lastActivityAt).getTime();
  const refMs = new Date(referenceTime).getTime();

  if (!Number.isFinite(lastMs) || !Number.isFinite(refMs)) {
    return false;
  }

  return (refMs - lastMs) > INACTIVITY_TIMEOUT_MS;
}

/**
 * Calculates milliseconds remaining before inactivity expiration.
 */
function getRemainingInactivityMs(lastActivityAt, referenceTime = new Date()) {
  if (!lastActivityAt) return INACTIVITY_TIMEOUT_MS;
  const lastMs = new Date(lastActivityAt).getTime();
  const refMs = new Date(referenceTime).getTime();
  return Math.max(0, INACTIVITY_TIMEOUT_MS - (refMs - lastMs));
}

/**
 * Identifies passive background requests that must NOT extend the session inactivity window.
 */
function isPassiveBackgroundRequest(req) {
  if (!req) return false;
  if (req.headers && req.headers['x-background-request'] === 'true') {
    return true;
  }
  const path = String(req.originalUrl || req.path || req.url || '').toLowerCase();
  if (path.includes('/notifications/sse') || path.includes('/customer/sse')) {
    return true;
  }
  if (path === '/health' || path === '/api/health' || path === '/api/v1/health') {
    return true;
  }
  if (path.includes('/location/update') && req.headers?.['x-silent-background'] === 'true') {
    return true;
  }
  return false;
}

/**
 * Records authenticated user activity, updating last_activity_at in DB and cache.
 * Throttled to at most once per minute per session to eliminate DB overhead.
 */
async function recordSessionActivity({
  userId,
  tokenFamily,
  isCustomer = false,
  req = null,
  pool,
  redisClient = null,
  now = new Date(),
}) {
  if (!userId && !tokenFamily) return;

  // In test environments, skip background DB calls unless explicitly requested
  if (process.env.NODE_ENV === 'test' && !req?.enableTestDbTracking) {
    return;
  }

  // 1. Skip passive background polling
  if (req && isPassiveBackgroundRequest(req)) {
    return;
  }

  const table = isCustomer ? 'customer_refresh_tokens' : 'refresh_tokens';
  const idCol = isCustomer ? 'customer_id' : 'user_id';
  const cacheKey = `act:${table}:${tokenFamily || userId}`;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  // 2. Throttle check (Redis or in-memory)
  if (redisClient && redisClient.status === 'ready') {
    try {
      const exists = await redisClient.get(cacheKey);
      if (exists) {
        return; // Already updated within last ACTIVITY_THROTTLE_MS
      }
      await redisClient.set(cacheKey, '1', 'PX', ACTIVITY_THROTTLE_MS);
    } catch (_) {
      // Fallback to local throttle on Redis error
    }
  } else {
    const lastWrite = localActivityThrottle.get(cacheKey);
    if (lastWrite && nowMs - lastWrite < ACTIVITY_THROTTLE_MS) {
      return;
    }
    localActivityThrottle.set(cacheKey, nowMs);
    // Periodically prune in-memory map
    if (localActivityThrottle.size > 5000) {
      for (const [k, ts] of localActivityThrottle.entries()) {
        if (nowMs - ts > ACTIVITY_THROTTLE_MS * 2) localActivityThrottle.delete(k);
      }
    }
  }

  // 3. Update database (asynchronously, non-blocking)
  if (!pool) return;

  try {
    if (tokenFamily) {
      await pool.query(
        `UPDATE ${table}
         SET last_activity_at = NOW()
         WHERE token_family = $1::uuid
           AND revoked = FALSE`,
        [tokenFamily]
      );
    } else {
      await pool.query(
        `UPDATE ${table}
         SET last_activity_at = NOW()
         WHERE ${idCol} = $1
           AND revoked = FALSE`,
        [userId]
      );
    }
  } catch (err) {
    // Non-fatal, preserve user request execution
    console.warn(`[sessionLifecycle] Activity update error (non-fatal): ${err.message}`);
  }
}

/**
 * Evaluates whether a refresh token row is eligible for rotation or expired by inactivity.
 *
 * @param {Object} tokenRow - Database row from refresh_tokens or customer_refresh_tokens
 * @param {Date} [now=new Date()]
 * @returns {{ isInactive: boolean, remainingMs: number }}
 */
function evaluateTokenInactivity(tokenRow, now = new Date()) {
  const lastActivity = tokenRow.last_activity_at || tokenRow.updated_at || tokenRow.created_at;
  const isInactive = isSessionInactive(lastActivity, now);
  const remainingMs = getRemainingInactivityMs(lastActivity, now);
  return { isInactive, remainingMs };
}

/**
 * Handles concurrent refresh requests for the same token family.
 * If a token is presented that was already rotated within the 30s grace period,
 * returns the newly rotated active token row instead of triggering a replay revocation.
 *
 * @param {Object} params
 * @param {Object} params.tokenRow - Row found by presented token
 * @param {string} params.table - 'refresh_tokens' or 'customer_refresh_tokens'
 * @param {Object} params.client - Database client / pool
 * @param {Date} [params.now=new Date()]
 * @returns {Promise<{ isGracePeriod: boolean, activeTokenRow?: Object, isReplay: boolean }>}
 */
async function handleConcurrentRotation({ tokenRow, table, client, now = new Date() }) {
  if (!tokenRow.revoked) {
    return { isGracePeriod: false, isReplay: false };
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const revokedAtMs = tokenRow.revoked_at ? new Date(tokenRow.revoked_at).getTime() : 0;
  const elapsedSinceRevoke = nowMs - revokedAtMs;

  // If token was revoked within ROTATION_GRACE_PERIOD_MS, treat as concurrent request
  if (tokenRow.revoked_at && elapsedSinceRevoke >= 0 && elapsedSinceRevoke <= ROTATION_GRACE_PERIOD_MS) {
    if (tokenRow.token_family) {
      const activeQuery = await client.query(
        `SELECT * FROM ${table}
         WHERE token_family = $1::uuid
           AND revoked = FALSE
         ORDER BY created_at DESC
         LIMIT 1`,
        [tokenRow.token_family]
      );

      if (activeQuery.rows.length > 0) {
        return {
          isGracePeriod: true,
          activeTokenRow: activeQuery.rows[0],
          isReplay: false,
        };
      }
    }
  }

  // Token was revoked outside the grace period — genuine replay attack
  return {
    isGracePeriod: false,
    isReplay: true,
  };
}

module.exports = {
  INACTIVITY_TIMEOUT_DAYS,
  INACTIVITY_TIMEOUT_MS,
  ROTATION_GRACE_PERIOD_MS,
  ACTIVITY_THROTTLE_MS,
  isSessionInactive,
  getRemainingInactivityMs,
  isPassiveBackgroundRequest,
  recordSessionActivity,
  evaluateTokenInactivity,
  handleConcurrentRotation,
};
