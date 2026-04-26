/**
 * services/auditService.js
 *
 * Centralized, non-blocking audit log writer.
 * Writes to the dedicated audit_logs table.
 * Failures are logged to console but never propagate to callers.
 */

'use strict';

const { pool } = require('../db');

/**
 * Write an audit log entry (non-blocking — never throws).
 *
 * @param {object} opts
 * @param {string}  opts.companyId   - company UUID
 * @param {string}  [opts.userId]    - actor user UUID (null for system/customer actions)
 * @param {string}  [opts.actorType] - 'user' | 'customer' | 'system'
 * @param {string}  opts.actionType  - e.g. 'job_approved', 'job_rejected', 'role_changed'
 * @param {string}  [opts.entityType] - e.g. 'job', 'user', 'invoice'
 * @param {string}  [opts.entityId]  - UUID or ID of the affected entity
 * @param {object}  [opts.oldValue]  - previous state (JSONB)
 * @param {object}  [opts.newValue]  - new state (JSONB)
 * @param {string}  [opts.ipAddress]
 * @param {string}  [opts.userAgent]
 * @returns {Promise<void>}
 */
async function log(opts) {
  const {
    companyId = null,
    userId = null,
    actorType = 'user',
    actionType,
    entityType = null,
    entityId = null,
    oldValue = null,
    newValue = null,
    ipAddress = null,
    userAgent = null,
  } = opts;

  if (!actionType) {
    console.warn('auditService.log called without actionType — skipping');
    return;
  }

  pool.query(
    `INSERT INTO audit_logs
       (company_id, user_id, actor_type, action_type, entity_type, entity_id,
        old_value, new_value, ip_address, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [
      companyId,
      userId,
      actorType,
      actionType,
      entityType,
      entityId ? String(entityId) : null,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      ipAddress,
      userAgent,
    ]
  ).catch((e) => {
    // Non-blocking: log to console but never throw
    console.error(`Audit log write failed [${actionType}]:`, e.message);
  });
}

/**
 * Convenience wrapper that extracts ip/userAgent from an Express request.
 */
function logFromRequest(req, opts) {
  return log({
    ...opts,
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') || null,
  });
}

module.exports = { log, logFromRequest };
