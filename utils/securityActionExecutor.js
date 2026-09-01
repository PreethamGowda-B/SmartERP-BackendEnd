/**
 * utils/securityActionExecutor.js
 *
 * Idempotent Remediation Action Executor & Rollback Manager for SmartERP.
 * Executes safe automated policies and approved Super Admin sensitive actions.
 * Provides complete rollback and reversal handling for all reversible actions.
 */

const { pool } = require('../db');
const { redisClient } = require('./redis');
const logger = require('./logger');
const { SECURITY_ACTION_TYPES } = require('./securityPolicyEngine');

/**
 * Executes a security action idempotently.
 *
 * @param {string} actionId - UUID of the security_action record
 * @param {string} [executedBy='security-policy-engine'] - Caller or SuperAdmin identifier
 * @returns {Promise<Object>} Execution result
 */
async function executeSecurityAction(actionId, executedBy = 'security-policy-engine') {
  const res = await pool.query(
    `SELECT id, incident_id, company_id, action_type, is_automated, approval_status, details 
     FROM security_actions WHERE id = $1`,
    [actionId]
  );

  if (res.rows.length === 0) {
    return { success: false, error: 'ACTION_NOT_FOUND' };
  }

  const action = res.rows[0];
  const details = action.details || {};

  // If action requires approval and is not approved, refuse execution
  if (!action.is_automated && action.approval_status !== 'approved' && executedBy === 'security-policy-engine') {
    return {
      success: false,
      error: 'APPROVAL_REQUIRED',
      message: 'Sensitive security action requires explicit Super Admin approval before execution.',
    };
  }

  let executionDetails = {};

  try {
    switch (action.action_type) {
      case SECURITY_ACTION_TYPES.IP_THROTTLE_TEMPORARY: {
        const ip = details.ipAddress;
        const durationMinutes = details.durationMinutes || 30;
        if (redisClient && redisClient.status === 'ready' && ip) {
          const key = `sec_quarantine:${ip}`;
          await redisClient.set(key, 'throttled', 'EX', durationMinutes * 60);
          executionDetails = { quarantinedIp: ip, durationMinutes, key };
        }
        break;
      }

      case SECURITY_ACTION_TYPES.SESSION_REVOKE_TARGET: {
        const userId = details.userId;
        if (userId) {
          if (redisClient && redisClient.status === 'ready') {
            await redisClient.set(`token_revoked:${userId}`, Date.now().toString(), 'EX', 86400);
          }
          executionDetails = { revokedUserId: userId, revocationTimestamp: Date.now() };
        }
        break;
      }

      case SECURITY_ACTION_TYPES.REQUIRE_STEP_UP_MFA: {
        const userId = details.userId;
        if (redisClient && redisClient.status === 'ready' && userId) {
          await redisClient.set(`mfa_required:${userId}`, 'true', 'EX', 86400); // 24-hr OTP requirement
          executionDetails = { mfaRequiredUserId: userId };
        }
        break;
      }

      case SECURITY_ACTION_TYPES.USER_SUSPEND: {
        const userId = details.userId;
        if (userId) {
          await pool.query(
            `UPDATE users SET is_active = FALSE WHERE id = $1`,
            [userId]
          );
          executionDetails = { suspendedUserId: userId };
        }
        break;
      }

      case SECURITY_ACTION_TYPES.COMPANY_SUSPEND: {
        const companyId = details.companyId;
        if (companyId) {
          await pool.query(
            `UPDATE companies SET is_suspended = TRUE WHERE id = $1`,
            [companyId]
          );
          executionDetails = { suspendedCompanyId: companyId };
        }
        break;
      }

      case SECURITY_ACTION_TYPES.IP_BLOCK_PERMANENT: {
        const ip = details.ipAddress;
        if (redisClient && redisClient.status === 'ready' && ip) {
          await redisClient.set(`sec_ip_blocked:${ip}`, 'permanent');
          executionDetails = { blockedIp: ip, duration: 'permanent' };
        }
        break;
      }

      default:
        throw new Error(`Unknown action type: ${action.action_type}`);
    }

    // Update action status to executed
    const updatedRes = await pool.query(
      `UPDATE security_actions
       SET approval_status = 'executed',
           executed_by = $1,
           details = $2
       WHERE id = $3
       RETURNING *`,
      [
        executedBy,
        JSON.stringify({ ...details, executionDetails, executedAt: new Date().toISOString() }),
        actionId,
      ]
    );

    logger.info(`[ActionExecutor] Successfully executed action ${actionId} (${action.action_type}) by ${executedBy}`);
    return { success: true, action: updatedRes.rows[0] };
  } catch (err) {
    logger.error(`[ActionExecutor] Execution failed for action ${actionId}: ${err.message}`);
    await pool.query(
      `UPDATE security_actions
       SET approval_status = 'failed',
           details = $1
       WHERE id = $2`,
      [JSON.stringify({ ...details, executionError: err.message, failedAt: new Date().toISOString() }), actionId]
    );
    return { success: false, error: err.message };
  }
}

/**
 * Reverts a previously executed security action (Rollback / Recovery).
 *
 * @param {string} actionId - UUID of the action in security_actions
 * @param {string} revertedBy - SuperAdmin identifier
 * @returns {Promise<Object>} Reversal result
 */
async function revertSecurityAction(actionId, revertedBy = 'super_admin') {
  const res = await pool.query(
    `SELECT id, incident_id, company_id, action_type, approval_status, details 
     FROM security_actions WHERE id = $1`,
    [actionId]
  );

  if (res.rows.length === 0) {
    return { success: false, error: 'ACTION_NOT_FOUND' };
  }

  const action = res.rows[0];
  const details = action.details || {};

  try {
    switch (action.action_type) {
      case SECURITY_ACTION_TYPES.IP_THROTTLE_TEMPORARY: {
        const ip = details.ipAddress;
        if (redisClient && redisClient.status === 'ready' && ip) {
          await redisClient.del(`sec_quarantine:${ip}`);
        }
        break;
      }

      case SECURITY_ACTION_TYPES.SESSION_REVOKE_TARGET: {
        const userId = details.userId;
        if (redisClient && redisClient.status === 'ready' && userId) {
          await redisClient.del(`token_revoked:${userId}`);
        }
        break;
      }

      case SECURITY_ACTION_TYPES.REQUIRE_STEP_UP_MFA: {
        const userId = details.userId;
        if (redisClient && redisClient.status === 'ready' && userId) {
          await redisClient.del(`mfa_required:${userId}`);
        }
        break;
      }

      case SECURITY_ACTION_TYPES.USER_SUSPEND: {
        const userId = details.userId;
        if (userId) {
          await pool.query(
            `UPDATE users SET is_active = TRUE WHERE id = $1`,
            [userId]
          );
        }
        break;
      }

      case SECURITY_ACTION_TYPES.COMPANY_SUSPEND: {
        const companyId = details.companyId;
        if (companyId) {
          await pool.query(
            `UPDATE companies SET is_suspended = FALSE WHERE id = $1`,
            [companyId]
          );
        }
        break;
      }

      case SECURITY_ACTION_TYPES.IP_BLOCK_PERMANENT: {
        const ip = details.ipAddress;
        if (redisClient && redisClient.status === 'ready' && ip) {
          await redisClient.del(`sec_ip_blocked:${ip}`);
        }
        break;
      }

      default:
        break;
    }

    const updatedRes = await pool.query(
      `UPDATE security_actions
       SET approval_status = 'reverted',
           reverted_at = NOW(),
           details = $1
       WHERE id = $2
       RETURNING *`,
      [
        JSON.stringify({ ...details, revertedAt: new Date().toISOString(), revertedBy }),
        actionId,
      ]
    );

    logger.info(`[ActionExecutor] Successfully reverted action ${actionId} (${action.action_type}) by ${revertedBy}`);
    return { success: true, action: updatedRes.rows[0] };
  } catch (err) {
    logger.error(`[ActionExecutor] Reversal failed for action ${actionId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = {
  executeSecurityAction,
  revertSecurityAction,
};
