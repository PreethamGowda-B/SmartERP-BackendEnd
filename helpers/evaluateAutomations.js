const { pool } = require('../db');

const SUPPORTED_AUTOMATION_ACTIONS = Object.freeze([
  'escalate_priority',
]);

function isSupportedAutomationAction(actionType) {
  return SUPPORTED_AUTOMATION_ACTIONS.includes(actionType);
}

function unsupportedAction(actionType) {
  return {
    success: false,
    actionType,
    error: 'UNSUPPORTED_AUTOMATION_ACTION',
    message: 'This automation action is not supported.',
  };
}

async function executeAutomationAction(actionType, payload = {}, query = (...args) => pool.query(...args)) {
  const { companyId, jobId } = payload;
  if (!isSupportedAutomationAction(actionType)) return unsupportedAction(actionType);
  if (companyId === undefined || companyId === null || String(companyId).trim() === '') {
    return { success: false, actionType, error: 'COMPANY_CONTEXT_REQUIRED', message: 'Company context is required.' };
  }

  try {
    let result;
    if (actionType === 'escalate_priority') {
      if (jobId === undefined || jobId === null || String(jobId).trim() === '') {
        return { success: false, actionType, error: 'JOB_ID_REQUIRED', message: 'A job ID is required for priority escalation.' };
      }
      result = await query(
        `UPDATE jobs SET priority = 'urgent', updated_at = NOW()
         WHERE id::text = $1::text AND company_id::text = $2::text
         RETURNING id`,
        [String(jobId), String(companyId)]
      );
      if (result.rowCount === 0 || (Array.isArray(result.rows) && result.rows.length === 0)) {
        return { success: false, actionType, error: 'JOB_NOT_FOUND', message: 'The company job was not found.' };
      }
    }

    return { success: true, actionType };
  } catch (err) {
    console.error('Automation action failed:', err?.code || 'DATABASE_ERROR');
    return { success: false, actionType, error: 'ACTION_FAILED', message: 'The automation action could not be completed.' };
  }
}

/**
 * Evaluate rules only when explicitly invoked. No business-event listener is
 * registered here; persisted rules are not automatically event-driven.
 */
async function evaluateAutomationRules(triggerEvent, payload = {}, dependencies = {}) {
  const { companyId, jobId, machineId, itemId, details = '' } = payload;
  const query = dependencies.query || ((...args) => pool.query(...args));
  const emit = dependencies.emitSystemEvent || ((...args) => require('./eventBus').emitSystemEvent(...args));
  if (companyId === undefined || companyId === null || String(companyId).trim() === '') {
    return { success: false, results: [{ success: false, error: 'COMPANY_CONTEXT_REQUIRED' }] };
  }
  if (typeof triggerEvent !== 'string' || !triggerEvent.trim()) {
    return { success: false, results: [{ success: false, error: 'TRIGGER_EVENT_REQUIRED' }] };
  }

  let rules;
  try {
    const rulesRes = await query(
      `SELECT * FROM automation_rules
       WHERE company_id::text = $1::text
         AND trigger_event = $2
         AND is_active = true`,
      [String(companyId), triggerEvent.trim()]
    );
    rules = rulesRes.rows || [];
  } catch (err) {
    console.error('Automation rule lookup failed:', err?.code || 'DATABASE_ERROR');
    return { success: false, results: [{ success: false, error: 'RULE_LOOKUP_FAILED' }] };
  }

  const results = [];
  for (const rule of rules) {
    const outcome = await executeAutomationAction(
      rule.action_type,
      { companyId, jobId, machineId, itemId, details },
      query
    );
    results.push({ ruleId: rule.id, ruleName: rule.rule_name, ...outcome });
    if (outcome.success) {
      await emit('AUTOMATION_EXECUTED', {
        companyId,
        action: `Automation Rule Executed: ${rule.rule_name}`,
        details: { triggerEvent: triggerEvent.trim(), actionType: rule.action_type, jobId, machineId, itemId },
      });
    }
  }

  return { success: results.every((result) => result.success), results };
}

module.exports = {
  SUPPORTED_AUTOMATION_ACTIONS,
  isSupportedAutomationAction,
  executeAutomationAction,
  evaluateAutomationRules,
};
