/**
 * utils/errorLogger.js
 *
 * Section 9 — Centralized Error Logging System
 *
 * Captures application errors separately from the audit log.
 * Writes to the `error_logs` table (created on first use via auto-migration).
 * Falls back to console.error if DB write fails — never crashes the server.
 *
 * Usage:
 *   const errorLogger = require('../utils/errorLogger');
 *   errorLogger.log(err, { context: 'jobApproval', jobId, companyId });
 *   errorLogger.logFromRequest(req, err, { context: 'customerJobCreate' });
 */

'use strict';

const { pool } = require('../db');

// ─── Schema for error_logs is managed via versioned database migrations ───────
let _tableReady = true;

async function ensureTable() {
  return Promise.resolve();
}

// ─── Core log function ────────────────────────────────────────────────────────
/**
 * @param {Error|string} err
 * @param {object} [meta]
 * @param {string}  [meta.context]   - where the error occurred
 * @param {string}  [meta.companyId]
 * @param {string}  [meta.userId]
 * @param {string}  [meta.ipAddress]
 * @param {string}  [meta.userAgent]
 * @param {object}  [meta.extra]     - any additional key/value pairs
 */
function log(err, meta = {}) {
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? err.stack   : null;

  // Always write to console immediately
  console.error(`[ERROR] ${meta.context || 'unknown'}: ${message}`);

  // Safe UUID check for Postgres UUID columns
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const safeCompanyId = (meta.companyId && UUID_REGEX.test(String(meta.companyId))) ? meta.companyId : null;
  const safeUserId    = (meta.userId && UUID_REGEX.test(String(meta.userId))) ? meta.userId : null;
  const extraData = {
    ...(meta.extra || {}),
    ...(meta.companyId && !safeCompanyId ? { raw_company_id: meta.companyId } : {}),
    ...(meta.userId && !safeUserId ? { raw_user_id: meta.userId } : {})
  };

  // Write to DB non-blocking
  pool.query(
    `INSERT INTO error_logs
       (context, message, stack, metadata, company_id, user_id, ip_address, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [
      meta.context   || null,
      message,
      stack          || null,
      Object.keys(extraData).length > 0 ? JSON.stringify(extraData) : null,
      safeCompanyId,
      safeUserId,
      meta.ipAddress || null,
      meta.userAgent || null,
    ]
  ).catch((dbErr) => {
    // Absolute last resort — just console
    console.error('errorLogger DB write failed:', dbErr.message);
  });
}

/**
 * Convenience wrapper that extracts request context automatically.
 */
function logFromRequest(req, err, meta = {}) {
  return log(err, {
    ...meta,
    companyId: meta.companyId || req.user?.companyId || req.customer?.companyId || null,
    userId:    meta.userId    || req.user?.id         || req.customer?.id        || null,
    ipAddress: req.ip         || null,
    userAgent: req.get('user-agent') || null,
  });
}

// ─── Retention: purge errors older than 30 days ───────────────────────────────
async function purgeOldErrors() {
  try {
    const result = await pool.query(
      `DELETE FROM error_logs WHERE created_at < NOW() - INTERVAL '30 days'`
    );
    if (result.rowCount > 0) {
      console.log(`🧹 Error log retention: purged ${result.rowCount} old entries`);
    }
  } catch (e) {
    console.error('errorLogger purge failed:', e.message);
  }
}

module.exports = { log, logFromRequest, purgeOldErrors };
