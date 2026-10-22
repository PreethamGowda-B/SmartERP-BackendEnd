'use strict';

const ACCOUNT_STATE_CACHE_TTL = 60; // 60-second Redis cache to avoid heavy DB overhead
const accountStateLookupsByPool = new WeakMap();

function isUserAccountActive(user) {
  if (!user) return false;
  if (user.is_active !== true && user.is_active !== 'true') return false;
  if (user.status && (user.status === 'suspended' || user.status === 'inactive')) return false;
  return true;
}

function loadAccountStateOnce(pool, userId) {
  let lookups = accountStateLookupsByPool.get(pool);
  if (!lookups) {
    lookups = new Map();
    accountStateLookupsByPool.set(pool, lookups);
  }

  const key = String(userId);
  const existing = lookups.get(key);
  if (existing) return existing;

  const lookup = Promise.resolve()
    .then(() => pool.query(
      "SELECT is_active, COALESCE(NULLIF(to_jsonb(u)->>'status', ''), 'active') AS status FROM users u WHERE id = $1",
      [userId]
    ))
    .finally(() => {
      if (lookups.get(key) === lookup) lookups.delete(key);
    });
  lookups.set(key, lookup);
  return lookup;
}

async function verifyAccessAccountState({ pool, redisClient, userId, tokenIssuedAt }) {
  if (!userId) return { allowed: false, reason: 'user_missing' };

  // 1. Check Redis for immediate suspension or revocation signals
  if (redisClient?.status === 'ready') {
    try {
      // Check if user has been flagged as suspended/inactive in Redis
      const cachedSuspended = await redisClient.get(`user_suspended:${userId}`);
      if (cachedSuspended === '1') {
        return { allowed: false, reason: 'user_inactive' };
      }

      // Check if user session has been explicitly revoked
      const revokedAtValue = await redisClient.get(`token_revoked:${userId}`);
      if (revokedAtValue !== null) {
        const revokedAt = Number(revokedAtValue);
        const issuedAt = Number(tokenIssuedAt);
        if (!Number.isFinite(revokedAt) || !Number.isFinite(issuedAt) || issuedAt * 1000 <= revokedAt) {
          return { allowed: false, reason: 'session_revoked' };
        }
      }

      // Check cached active state
      const cachedActive = await redisClient.get(`user_active:${userId}`);
      if (cachedActive === '1') {
        return { allowed: true, reason: null };
      }
    } catch (_) {
      // Redis error: fall through to database check
    }
  }

  // 2. Query database for current account status
  // Collapse simultaneous cold-cache requests for the same user into one DB
  // lookup. Completed results are not retained, so account changes remain
  // visible on the next request.
  const result = await loadAccountStateOnce(pool, userId);
  if (!result.rows.length) return { allowed: false, reason: 'user_missing' };

  const user = result.rows[0];
  if (!isUserAccountActive(user)) {
    // Cache inactive status in Redis
    if (redisClient?.status === 'ready') {
      try {
        await redisClient.set(`user_suspended:${userId}`, '1', { EX: ACCOUNT_STATE_CACHE_TTL });
      } catch (_) {}
    }
    return { allowed: false, reason: 'user_inactive' };
  }

  // Cache verified active status in Redis (TTL: 60s)
  if (redisClient?.status === 'ready') {
    try {
      await redisClient.set(`user_active:${userId}`, '1', { EX: ACCOUNT_STATE_CACHE_TTL });
    } catch (_) {}
  }

  return { allowed: true, reason: null };
}

module.exports = { isUserAccountActive, verifyAccessAccountState };
