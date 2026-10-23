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
const { accountStateLockKey } = require('../services/accountReactivation');
const { canExecuteAutomaticPromptSuspension } = require('./promptInjectionPolicy');

async function executeUserSuspendAction({ action, actionId, executedBy }) {
  const userId = action.details?.userId;
  if (!userId) return { success: false, error: 'Target user is missing; suspension was not applied.' };
  if (!redisClient || redisClient.status !== 'ready') {
    return { success: false, error: 'Session revocation storage is unavailable; suspension was not applied.' };
  }

  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [accountStateLockKey(userId)]);
    const currentAction = await client.query('SELECT id, approval_status, details FROM security_actions WHERE id = $1 FOR UPDATE', [actionId]);
    if (!currentAction.rows.length) throw new Error('Security action not found.');
    if (currentAction.rows[0].approval_status === 'executed') {
      await client.query('COMMIT');
      transactionStarted = false;
      return { success: true, alreadyExecuted: true, action: currentAction.rows[0] };
    }
    const currentDetails = currentAction.rows[0].details && typeof currentAction.rows[0].details === 'object'
      ? currentAction.rows[0].details : {};
    const automaticPromptSuspension = canExecuteAutomaticPromptSuspension({ action, details: currentDetails });
    const executableStatus = currentAction.rows[0].approval_status === 'approved'
      || (automaticPromptSuspension && currentAction.rows[0].approval_status === 'pending');
    if (!executableStatus) {
      throw new Error(`Suspension action is no longer executable (${currentAction.rows[0].approval_status}).`);
    }

    const target = await client.query(
      `SELECT id::text, role, company_id::text, is_active,
              COALESCE(NULLIF(to_jsonb(u)->>'status', ''), 'active') AS account_status
       FROM users u WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (!target.rows.length) throw new Error('Target user was not found; suspension was not applied.');
    if (target.rows[0].role === 'super_admin') throw new Error('CANNOT_SUSPEND_SUPERADMIN: Super Admin accounts cannot be suspended.');
    if (action.company_id && String(target.rows[0].company_id || '') !== String(action.company_id)) {
      throw new Error('Target user does not belong to the action company.');
    }
    if (target.rows[0].is_active !== true || ['suspended', 'inactive'].includes(String(target.rows[0].account_status).toLowerCase())) {
      throw new Error('Target account is already inactive; refusing to replace its existing account state.');
    }

    const statusColumn = await client.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'status') AS present`
    );
    if (statusColumn.rows[0]?.present) {
      await client.query("UPDATE users SET is_active = FALSE, status = 'suspended' WHERE id = $1", [userId]);
    } else {
      await client.query('UPDATE users SET is_active = FALSE WHERE id = $1', [userId]);
    }
    await client.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1::uuid AND revoked = FALSE', [userId]);

    const revokedAt = Date.now().toString();
    await redisClient.set(`token_revoked:${userId}`, revokedAt, 'EX', 86400);
    await redisClient.set(`user_suspended:${userId}`, '1', 'EX', 86400 * 7);
    await redisClient.del(`user_active:${userId}`);

    const details = currentAction.rows[0].details && typeof currentAction.rows[0].details === 'object'
      ? currentAction.rows[0].details : action.details || {};
    const expectedStatus = automaticPromptSuspension ? 'pending' : 'approved';
    const updated = await client.query(
      `UPDATE security_actions SET approval_status = 'executed', executed_by = $1, details = $2::jsonb
       WHERE id = $3 AND approval_status = $4 RETURNING *`,
      [executedBy, JSON.stringify({
        ...details,
        executionDetails: {
          suspendedUserId: userId,
          previousIsActive: target.rows[0].is_active === true,
          previousStatus: target.rows[0].account_status,
          revocationTimestamp: revokedAt,
        },
        executedAt: new Date().toISOString(),
      }), actionId, expectedStatus]
    );
    if (!updated.rows.length) throw new Error('Suspension action changed while executing.');

    await client.query('COMMIT');
    transactionStarted = false;
    return { success: true, action: updated.rows[0] };
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

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

  // Serialize account suspensions with Super Admin reactivation. The shared
  // advisory lock and fresh action-state read prevent a stale approval from
  // re-suspending an account after it was reactivated.
  if (action.action_type === SECURITY_ACTION_TYPES.USER_SUSPEND) {
    const result = await executeUserSuspendAction({ action, actionId, executedBy });
    if (result.success && !result.alreadyExecuted) {
      logger.info(`[ActionExecutor] Successfully executed action ${actionId} (${action.action_type}) by ${executedBy}`);
    } else if (!result.success) {
      logger.warn(`[ActionExecutor] USER_SUSPEND action ${actionId} was not executed: ${result.error}`);
      await pool.query(
        `UPDATE security_actions SET approval_status = 'failed', details = $1::jsonb
         WHERE id = $2 AND approval_status = 'approved'`,
        [JSON.stringify({ ...(action.details || {}), executionError: result.error, failedAt: new Date().toISOString() }), actionId]
      ).catch(() => {});
    }
    return result;
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
          if (!redisClient || redisClient.status !== 'ready') {
            throw new Error('Session revocation storage is unavailable; action was not marked executed.');
          }
          const revocationTimestamp = Date.now();
          await redisClient.set(`token_revoked:${userId}`, revocationTimestamp.toString(), 'EX', 86400);
          executionDetails = { revokedUserId: userId, revocationTimestamp };
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

      case SECURITY_ACTION_TYPES.USER_SUSPEND:
        throw new Error('USER_SUSPEND must use the serialized account-state executor.');

      case SECURITY_ACTION_TYPES.COMPANY_SUSPEND: {
        const companyId = details.companyId;
        if (companyId) {
          const company = await pool.query('SELECT status FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
          if (!company.rows.length) throw new Error('Target company was not found; suspension was not applied.');
          await pool.query("UPDATE companies SET status = 'suspended' WHERE id = $1", [companyId]);
          if (redisClient?.status === 'ready') await redisClient.del(`company_suspended:${companyId}`);
          executionDetails = { suspendedCompanyId: companyId, previousStatus: company.rows[0].status };
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
        if (userId && (!redisClient || redisClient.status !== 'ready')) {
          throw new Error('Session revocation storage is unavailable; session was not restored.');
        }
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
          if (!redisClient || redisClient.status !== 'ready') {
            throw new Error('Session revocation storage is unavailable; user was not restored.');
          }
          const priorActive = details.executionDetails?.previousIsActive;
          if (typeof priorActive !== 'boolean') throw new Error('Saved user account state is missing; refusing to restore an unknown prior state.');
          await redisClient.set(`token_revoked:${userId}`, Date.now().toString(), 'EX', 86400);
          await pool.query(
            `UPDATE users SET is_active = $1 WHERE id = $2`,
            [priorActive, userId]
          );
          await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1::uuid AND revoked = FALSE', [userId]);
          if (priorActive) {
            await redisClient.del(`user_suspended:${userId}`);
            await redisClient.set(`user_active:${userId}`, '1', 'EX', 60);
          }
        }
        break;
      }

      case SECURITY_ACTION_TYPES.COMPANY_SUSPEND: {
        const companyId = details.companyId;
        if (companyId) {
          const previousStatus = details.executionDetails?.previousStatus;
          if (typeof previousStatus !== 'string' || previousStatus === 'suspended') {
            throw new Error('Saved company status is missing or was already suspended; refusing to overwrite its current state.');
          }
          const restored = await pool.query(
            "UPDATE companies SET status = $1 WHERE id = $2 AND status = 'suspended' RETURNING id",
            [previousStatus, companyId]
          );
          if (!restored.rows.length) throw new Error('Company status changed after suspension; refusing to overwrite the newer status.');
          if (redisClient?.status === 'ready') await redisClient.del(`company_suspended:${companyId}`);
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
