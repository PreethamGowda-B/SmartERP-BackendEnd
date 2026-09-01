/**
 * utils/securityPolicyEngine.js
 *
 * Deterministic Remediation Policy Engine for SmartERP Defensive Security AI.
 * Separates Detection, AI Analysis, Policy Decision, and Action Execution.
 *
 * POLICY PRINCIPLES:
 * 1. Only SAFE, REVERSIBLE actions can be automated (e.g. temporary IP throttle, token revocation).
 * 2. All SENSITIVE, DESTRUCTIVE actions MANDATE explicit Super Admin approval (status: 'pending').
 * 3. Strict Idempotency: Prevents duplicate action creation or double-execution across BullMQ retries.
 * 4. Audit Trail: Every proposed/executed action is recorded in `security_actions`.
 */

const crypto = require('crypto');
const { pool } = require('../db');
const logger = require('./logger');

/**
 * Standard Security Action Types
 */
const SECURITY_ACTION_TYPES = {
  // Safe / Reversible Actions (Automated or Instant)
  IP_THROTTLE_TEMPORARY: 'IP_THROTTLE_TEMPORARY',
  SESSION_REVOKE_TARGET: 'SESSION_REVOKE_TARGET',
  REQUIRE_STEP_UP_MFA: 'REQUIRE_STEP_UP_MFA',

  // Sensitive / Destructive Actions (MANDATORY Super Admin Approval)
  USER_SUSPEND: 'USER_SUSPEND',
  COMPANY_SUSPEND: 'COMPANY_SUSPEND',
  IP_BLOCK_PERMANENT: 'IP_BLOCK_PERMANENT',
};

/**
 * Evaluates deterministic policy rules for an incident and determines
 * which safe automated actions to execute and which sensitive actions to propose.
 *
 * @param {Object} incident - Incident record from security_incidents
 * @returns {Array<Object>} List of proposed/decided action payloads
 */
function evaluatePolicyForIncident(incident) {
  const actions = [];
  const threatCategory = incident.threat_category;
  const riskScore = incident.risk_score || 0;
  const sourceIp = incident.source_ip;
  const targetUserId = incident.target_user_id;
  const companyId = incident.company_id;

  switch (threatCategory) {
    case 'SUPERADMIN_PROBE':
      // Safe: Immediately throttle offending IP in Redis for 60 minutes
      if (sourceIp) {
        actions.push({
          actionType: SECURITY_ACTION_TYPES.IP_THROTTLE_TEMPORARY,
          isAutomated: true,
          requiresApproval: false,
          reason: 'Automated 60-min rate-limit quarantine due to unauthorized Super Admin endpoint probing.',
          policyRule: 'RULE_SUPERADMIN_PROBE_THROTTLE',
          target: sourceIp,
          payload: { ipAddress: sourceIp, durationMinutes: 60 },
        });
      }
      // Sensitive: Propose permanent IP block for Super Admin review
      if (sourceIp && riskScore >= 85) {
        actions.push({
          actionType: SECURITY_ACTION_TYPES.IP_BLOCK_PERMANENT,
          isAutomated: false,
          requiresApproval: true,
          reason: 'Critical severity unauthorized Super Admin access probe from external host.',
          policyRule: 'RULE_SUPERADMIN_CRITICAL_IP_BLOCK',
          target: sourceIp,
          payload: { ipAddress: sourceIp },
        });
      }
      break;

    case 'CREDENTIAL_STUFFING':
      // Safe: 30-min IP rate throttle
      if (sourceIp) {
        actions.push({
          actionType: SECURITY_ACTION_TYPES.IP_THROTTLE_TEMPORARY,
          isAutomated: true,
          requiresApproval: false,
          reason: 'Repeated authentication failures exceeding sliding-window velocity threshold.',
          policyRule: 'RULE_BRUTEFORCE_IP_THROTTLE',
          target: sourceIp,
          payload: { ipAddress: sourceIp, durationMinutes: 30 },
        });
      }
      // Safe: Force step-up verification if single target user identified
      if (targetUserId) {
        actions.push({
          actionType: SECURITY_ACTION_TYPES.REQUIRE_STEP_UP_MFA,
          isAutomated: true,
          requiresApproval: false,
          reason: 'Target account subject to credential stuffing attempts; requiring OTP on next login.',
          policyRule: 'RULE_FORCE_OTP_CHALLENGE',
          target: targetUserId,
          payload: { userId: targetUserId },
        });
      }
      break;

    case 'CROSS_TENANT_IDOR':
      // Safe: Revoke active session tokens for the probing user
      if (targetUserId) {
        actions.push({
          actionType: SECURITY_ACTION_TYPES.SESSION_REVOKE_TARGET,
          isAutomated: true,
          requiresApproval: false,
          reason: 'Immediate session invalidation following cross-tenant access attempt.',
          policyRule: 'RULE_IDOR_SESSION_REVOCATION',
          target: targetUserId,
          payload: { userId: targetUserId },
        });
      }
      // Sensitive: Propose user suspension for Super Admin review
      if (targetUserId) {
        actions.push({
          actionType: SECURITY_ACTION_TYPES.USER_SUSPEND,
          isAutomated: false,
          requiresApproval: true,
          reason: 'Intentional cross-tenant parameter tampering requires administrative review.',
          policyRule: 'RULE_IDOR_SUSPEND_PROPOSAL',
          target: targetUserId,
          payload: { userId: targetUserId, companyId },
        });
      }
      break;

    case 'PRIVILEGE_ESCALATION':
      if (targetUserId) {
        actions.push({
          actionType: SECURITY_ACTION_TYPES.SESSION_REVOKE_TARGET,
          isAutomated: true,
          requiresApproval: false,
          reason: 'Repeated unauthorized RBAC permission probing; resetting caller tokens.',
          policyRule: 'RULE_RBAC_SESSION_RESET',
          target: targetUserId,
          payload: { userId: targetUserId },
        });
      }
      break;

    case 'ROUTE_SCAN':
      if (sourceIp) {
        actions.push({
          actionType: SECURITY_ACTION_TYPES.IP_THROTTLE_TEMPORARY,
          isAutomated: true,
          requiresApproval: false,
          reason: 'Automated vulnerability scanner probes detected from host.',
          policyRule: 'RULE_SCANNER_QUARANTINE',
          target: sourceIp,
          payload: { ipAddress: sourceIp, durationMinutes: 60 },
        });
      }
      break;

    default:
      break;
  }

  return actions;
}

/**
 * Generates a deterministic idempotency key for an action proposal.
 */
function generateActionIdempotencyKey(incidentId, actionType, target) {
  return crypto
    .createHash('sha256')
    .update(`${incidentId}:${actionType}:${target || 'none'}`)
    .digest('hex');
}

/**
 * Evaluates and records remediation policy actions for an incident in `security_actions`.
 * Idempotently skips already proposed or executed actions.
 *
 * @param {Object} incident - Incident record
 * @returns {Promise<Array<Object>>} Created or existing action records
 */
async function applyRemediationPolicy(incident) {
  const decisions = evaluatePolicyForIncident(incident);
  const recordedActions = [];

  for (const decision of decisions) {
    const idempotencyKey = generateActionIdempotencyKey(
      incident.id,
      decision.actionType,
      decision.target
    );

    // 1. Idempotency Check: Verify if action already recorded for this incident
    const checkRes = await pool.query(
      `SELECT id, action_type, approval_status, is_automated, details 
       FROM security_actions 
       WHERE incident_id = $1 
         AND action_type = $2 
         AND details->>'idempotencyKey' = $3`,
      [incident.id, decision.actionType, idempotencyKey]
    );

    if (checkRes.rows.length > 0) {
      // Already recorded; skip duplicate
      recordedActions.push(checkRes.rows[0]);
      continue;
    }

    // 2. Determine initial approval status
    const initialStatus = decision.requiresApproval ? 'pending' : 'executed';
    const executedBy = decision.isAutomated ? 'security-policy-engine' : null;

    const actionDetails = {
      ...decision.payload,
      idempotencyKey,
      policyRule: decision.policyRule,
      reason: decision.reason,
      proposedAt: new Date().toISOString(),
    };

    // 3. Insert action record into security_actions
    const insertRes = await pool.query(
      `INSERT INTO security_actions 
       (incident_id, company_id, action_type, is_automated, approval_status, executed_by, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [
        incident.id,
        incident.company_id,
        decision.actionType,
        decision.isAutomated,
        initialStatus,
        executedBy,
        JSON.stringify(actionDetails),
      ]
    );

    const newAction = insertRes.rows[0];
    recordedActions.push(newAction);
    logger.info(`[PolicyEngine] Recorded action ${newAction.id} (Type: ${newAction.action_type}, Status: ${newAction.approval_status})`);
  }

  return recordedActions;
}

module.exports = {
  SECURITY_ACTION_TYPES,
  evaluatePolicyForIncident,
  generateActionIdempotencyKey,
  applyRemediationPolicy,
};
