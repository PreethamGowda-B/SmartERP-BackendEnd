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

// ─── Ensure error_logs table exists ──────────────────────────────────────────
let _tableReady = false;

async function ensureTable() {
  if (_tableReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        context     VARCHAR(200),
        message     TEXT,
        stack       TEXT,
        metadata    JSONB,
        company_id  UUID,
        user_id     UUID,
        ip_address  VARCHAR(100),
        user_agent  TEXT,
        created_at  TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_error_logs_created_at  ON error_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_error_logs_company_id  ON error_logs(company_id);
      CREATE INDEX IF NOT EXISTS idx_error_logs_context     ON error_logs(context);
    `);
    _tableReady = true;
  } catch (e) {
    // Table creation failure is non-fatal
    console.error('errorLogger: table setup failed:', e.message);
  }
}

// Run table setup once on module load (non-blocking)
ensureTable().catch(() => {});

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

  // Write to DB non-blocking
  pool.query(
    `INSERT INTO error_logs
       (context, message, stack, metadata, company_id, user_id, ip_address, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [
      meta.context   || null,
      message,
      stack          || null,
      meta.extra     ? JSON.stringify(meta.extra) : null,
      meta.companyId || null,
      meta.userId    || null,
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
