const crypto = require('crypto');

/**
 * 🔒 Token Hash Utility
 *
 * Implements cryptographic hashing for refresh tokens at rest.
 * Prevents plain-text tokens from ever being exposed via database dumps or read queries.
 */

/**
 * Computes a deterministic SHA-256 hash of a refresh token.
 * @param {string} token - Raw JWT refresh token string
 * @returns {string} 64-character hexadecimal SHA-256 hash
 */
function hashToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('hashToken requires a non-empty string token');
  }
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * Validates a raw token against a stored token value.
 *
 * ⚠️ TEMPORARY MIGRATION LOGIC:
 * 1. Checks if stored value matches sha256(rawToken).
 * 2. If not, checks if stored value equals rawToken (legacy plaintext migration fallback).
 *
 * REMOVAL CONDITION:
 * This plaintext fallback must be removed after the 30-day maximum refresh token expiration window
 * has elapsed from the deployment date, once all legacy active tokens have been rotated.
 * Set environment variable `DISABLE_LEGACY_PLAINTEXT_REFRESH=true` to enforce hash-only immediately.
 *
 * @param {string} rawToken - Incoming refresh token from client
 * @param {string} storedValue - Value retrieved from the refresh_tokens table
 * @returns {boolean}
 */
function verifyTokenHash(rawToken, storedValue) {
  if (!rawToken || !storedValue) return false;

  const computedHash = hashToken(rawToken);

  // 1. Primary path: Compare computed SHA-256 hash
  if (computedHash === storedValue) {
    return true;
  }

  // 2. Temporary migration path: Check legacy plaintext match if not explicitly disabled
  if (process.env.DISABLE_LEGACY_PLAINTEXT_REFRESH !== 'true') {
    if (rawToken.trim() === storedValue.trim()) {
      return true;
    }
  }

  return false;
}

module.exports = {
  hashToken,
  verifyTokenHash
};
