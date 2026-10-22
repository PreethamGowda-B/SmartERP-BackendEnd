'use strict';

const ACCOUNT_STATE_CACHE_TTL = 60; // 60-second Redis cache to avoid heavy DB overhead

function isUserAccountActive(user) {
  return Boolean(user) && user.is_active === true && user.status !== 'suspended';
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
  const result = await pool.query('SELECT is_active, status, role FROM users WHERE id = $1', [userId]);
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
