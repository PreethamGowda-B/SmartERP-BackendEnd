/**
 * utils/securityEmitter.js
 *
 * Lightweight, non-blocking telemetry publisher for SmartERP Security AI.
 * Emits security signals (auth failures, tenant mismatches, RBAC denials,
 * API route sweeps, prompt injections, and suspicious uploads) to the
 * background pipeline without impacting API request latency.
 */

const { pool } = require('../db');
const { redisClient } = require('./redis');
const logger = require('./logger');

/**
 * Standardized Security Event Types
 */
const SECURITY_EVENT_TYPES = {
  AUTH_FAILED: 'auth.failed',
  AUTH_TOKEN_INVALID: 'auth.token_invalid',
  AUTH_COMPANY_SUSPENDED: 'auth.company_suspended',
  TENANT_MISMATCH: 'tenant.mismatch',
  TENANT_IDOR_ATTEMPT: 'tenant.idor_attempt',
  RBAC_DENIED: 'rbac.denied',
  ADMIN_UNAUTHORIZED: 'admin.unauthorized_access',
  ROUTE_SCAN: 'route.enumeration_scan',
  PROMPT_INJECTION: 'prompt.injection_attempt',
  FILE_SUSPICIOUS: 'file.signature_mismatch',
  DATA_EXFILTRATION_SURGE: 'data.export_surge',
  RATE_LIMIT_EXCEEDED: 'ratelimit.exceeded',
};

/**
 * Emits a security event asynchronously.
 *
 * @param {Object} eventData
 * @param {string} [eventData.companyId]
 * @param {string} [eventData.userId]
 * @param {string} eventData.eventType - One of SECURITY_EVENT_TYPES or custom string
 * @param {string} [eventData.severity='low'] - 'low' | 'medium' | 'high' | 'critical'
 * @param {string} [eventData.ipAddress]
 * @param {string} [eventData.userAgent]
 * @param {string} [eventData.endpoint]
 * @param {string} [eventData.httpMethod]
 * @param {number} [eventData.statusCode]
 * @param {Object} [eventData.metadata={}]
 */
function emitSecurityEvent(eventData) {
  // Run completely detached from Express request execution loop
  setImmediate(async () => {
    try {
      const companyId = eventData.companyId ? String(eventData.companyId) : null;
      const userId = eventData.userId ? String(eventData.userId) : null;
      const eventType = String(eventData.eventType || 'unknown.event');
      const severity = ['low', 'medium', 'high', 'critical'].includes(eventData.severity)
        ? eventData.severity
        : 'low';
      const ipAddress = eventData.ipAddress ? String(eventData.ipAddress).slice(0, 50) : null;
      const userAgent = eventData.userAgent ? String(eventData.userAgent).slice(0, 500) : null;
      const endpoint = eventData.endpoint ? String(eventData.endpoint).slice(0, 255) : null;
      const httpMethod = eventData.httpMethod ? String(eventData.httpMethod).toUpperCase().slice(0, 10) : null;
      const statusCode = Number.isInteger(eventData.statusCode) ? eventData.statusCode : null;
      // Sanitize metadata to remove any passwords, tokens, or credentials
      const sanitizeMetadata = (obj) => {
        if (!obj || typeof obj !== 'object') return {};
        const redactedKeys = ['password', 'password_hash', 'token', 'access_token', 'refresh_token', 'secret', 'authorization', 'otp', 'credit_card', 'cvv', 'api_key'];
        const clean = {};
        for (const [k, v] of Object.entries(obj)) {
          if (redactedKeys.some((bad) => k.toLowerCase().includes(bad))) {
            clean[k] = '[REDACTED]';
          } else if (typeof v === 'object' && v !== null) {
            clean[k] = sanitizeMetadata(v);
          } else {
            clean[k] = v;
          }
        }
        return clean;
      };

      const cleanMetadata = typeof eventData.metadata === 'object' && eventData.metadata !== null
        ? sanitizeMetadata(eventData.metadata)
        : {};

      // 1. Direct Asynchronous Insert to security_events table
      if (pool && pool.query) {
        await pool.query(
          `INSERT INTO security_events 
           (company_id, user_id, event_type, severity, ip_address, user_agent, endpoint, http_method, status_code, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
          [
            companyId,
            userId,
            eventType,
            severity,
            ipAddress,
            userAgent,
            endpoint,
            httpMethod,
            statusCode,
            JSON.stringify(cleanMetadata),
          ]
        ).catch((dbErr) => {
          logger.warn(`SecurityEmitter DB Insert Warning: ${dbErr.message}`);
        });
      }

      // 2. Sliding window counter in Redis for high-frequency correlation
      if (redisClient && redisClient.status === 'ready' && ipAddress) {
        const windowKey = `sec_window:${eventType}:${ipAddress}`;
        try {
          const count = await redisClient.incr(windowKey);
          if (count === 1) {
            await redisClient.expire(windowKey, 300); // 5-minute sliding aggregation window
          }

          // If threshold reached (e.g. >10 auth failures in 5 min), trigger immediate BullMQ triage
          if (count >= 10 && eventType === SECURITY_EVENT_TYPES.AUTH_FAILED) {
            const { enqueueSecurityEvent } = require('./queue');
            await enqueueSecurityEvent({
              trigger: 'sliding_window_threshold',
              eventType,
              ipAddress,
              count,
              companyId,
              userId,
              severity: 'high',
            }).catch(() => {});
          }
        } catch (redisErr) {
          // Non-blocking fallback
        }
      }
    } catch (err) {
      logger.warn(`SecurityEmitter Unexpected Error: ${err.message}`);
    }
  });
}

module.exports = {
  emitSecurityEvent,
  SECURITY_EVENT_TYPES,
};
