/**
 * Immutable Enterprise Audit Logger Engine
 * Writes immutable audit trail records into `job_audit_logs` table.
 */

const { pool } = require('../db');

async function logJobAudit({
  companyId,
  jobId,
  userId,
  userRole,
  action,
  oldState = null,
  newState = null,
  oldValue = null,
  newValue = null,
  reason = null,
  metadata = null,
  ipAddress = null,
}) {
  if (!jobId || !companyId || !action) {
    console.warn('⚠️  logJobAudit missing required fields:', { companyId, jobId, action });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO job_audit_logs 
       (company_id, job_id, user_id, user_role, action, old_state, new_state, old_value, new_value, reason, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        String(companyId),
        jobId,
        userId || null,
        userRole || null,
        action,
        oldState,
        newState,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        reason,
        metadata ? JSON.stringify(metadata) : null,
        ipAddress,
      ]
    );
    console.log(`📝 Immutable Audit Logged: [${action}] for Job ${jobId} (User: ${userId}, Role: ${userRole})`);
  } catch (err) {
    console.error('❌ Failed to log job audit trail:', err.message);
  }
}

module.exports = { logJobAudit };
