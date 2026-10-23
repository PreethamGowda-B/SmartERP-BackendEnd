'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getVerifiedPromptEvidence, THREAT_CATEGORIES } = require('../jobs/securityWorker');
const { evaluatePolicyForIncident, SECURITY_ACTION_TYPES } = require('../utils/securityPolicyEngine');
const { getPromptInjectionPolicy, canExecuteAutomaticPromptSuspension } = require('../utils/promptInjectionPolicy');

test('prompt evidence ignores unverified, other-user, and cross-company events', () => {
  const events = [
    { event_type: 'prompt.injection_attempt', user_id: 'u1', company_id: 'c1', metadata: { isSecurityThreat: true, category: 'SYSTEM_INSTRUCTION_OVERRIDE' } },
    { event_type: 'prompt.injection_attempt', user_id: 'u1', company_id: 'c1', metadata: { reason: 'legacy event' } },
    { event_type: 'prompt.injection_attempt', user_id: 'u2', company_id: 'c1', metadata: { isSecurityThreat: true, category: 'CREDENTIAL_EXFILTRATION' } },
    { event_type: 'prompt.injection_attempt', user_id: 'u1', company_id: 'c2', metadata: { isSecurityThreat: true, category: 'SQL_INJECTION' } },
    { event_type: 'prompt.injection_attempt', user_id: 'u1', company_id: null, metadata: { isSecurityThreat: true, category: 'SQL_INJECTION' } },
  ];
  assert.deepEqual(getVerifiedPromptEvidence(events, 'u1', 'c1'), {
    count: 1,
    categories: ['SYSTEM_INSTRUCTION_OVERRIDE'],
  });
  assert.deepEqual(getVerifiedPromptEvidence(events, 'u1', null), { count: 1, categories: ['SQL_INJECTION'] });
});

test('one blocked prompt records no automatic containment action', () => {
  const actions = evaluatePolicyForIncident({
    threat_category: THREAT_CATEGORIES.PROMPT_INJECTION,
    risk_score: 75,
    source_ip: '192.0.2.10',
    target_user_id: 'u1',
    company_id: 'c1',
    ai_analysis: { verifiedPromptAttemptCount: 1, verifiedPromptCategories: ['SYSTEM_INSTRUCTION_OVERRIDE'] },
  });
  assert.deepEqual(actions, []);
});

test('verified attempts 1 through 15 never throttle or revoke sessions; the 16th proposes user-specific suspension for approval by default', () => {
  const previous = process.env.AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED;
  delete process.env.AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED;
  try {
    assert.deepEqual(getPromptInjectionPolicy(), { threshold: 16, windowMinutes: 15, autoSuspendEnabled: false });
    for (let count = 1; count < 16; count += 1) {
      const actions = evaluatePolicyForIncident({
        threat_category: THREAT_CATEGORIES.PROMPT_INJECTION,
        risk_score: 84,
        target_user_id: 'u1',
        company_id: 'c1',
        ai_analysis: { verifiedPromptAttemptCount: count },
      });
      assert.deepEqual(actions, [], `attempt ${count} must not cause containment`);
    }
    const actions = evaluatePolicyForIncident({
      threat_category: THREAT_CATEGORIES.PROMPT_INJECTION,
      risk_score: 90,
      target_user_id: 'u1',
      company_id: 'c1',
      ai_analysis: { verifiedPromptAttemptCount: 16 },
    });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].actionType, SECURITY_ACTION_TYPES.USER_SUSPEND);
    assert.equal(actions[0].target, 'u1');
    assert.equal(actions[0].payload.companyId, 'c1');
    assert.equal(actions[0].isAutomated, false);
    assert.equal(actions[0].requiresApproval, true);
  } finally {
    if (previous === undefined) delete process.env.AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED;
    else process.env.AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED = previous;
  }
});

test('automatic account suspension is explicit opt-in and Super Admin remains excluded', () => {
  const previous = process.env.AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED;
  process.env.AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED = 'true';
  try {
    const incident = {
      threat_category: THREAT_CATEGORIES.PROMPT_INJECTION,
      risk_score: 90,
      target_user_id: 'u1',
      company_id: 'c1',
      ai_analysis: { verifiedPromptAttemptCount: 16 },
    };
    const action = evaluatePolicyForIncident(incident)[0];
    assert.equal(action.actionType, SECURITY_ACTION_TYPES.USER_SUSPEND);
    assert.equal(action.isAutomated, true);
    assert.equal(action.requiresApproval, false);
    assert.equal(action.payload.autoSuspensionEnabled, true);
    assert.deepEqual(evaluatePolicyForIncident({ ...incident, target_user_role: 'super_admin' }), []);
  } finally {
    if (previous === undefined) delete process.env.AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED;
    else process.env.AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED = previous;
  }
});

test('automatic suspension executor gate requires the current flag, threshold, window, policy marker, user, and company', () => {
  const action = { is_automated: true };
  const details = {
    policyRule: 'RULE_PROMPT_INJECTION_AUTO_SUSPEND',
    autoSuspensionEnabled: true,
    verifiedPromptAttemptCount: 16,
    detectionWindowMinutes: 15,
    userId: 'u1',
    companyId: 'c1',
  };
  const enabledEnv = {
    AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED: 'true',
    AI_PROMPT_INJECTION_THRESHOLD: '16',
    AI_PROMPT_INJECTION_WINDOW_MINUTES: '15',
  };
  assert.equal(canExecuteAutomaticPromptSuspension({ action, details, env: enabledEnv }), true);
  assert.equal(canExecuteAutomaticPromptSuspension({ action, details, env: { ...enabledEnv, AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED: 'false' } }), false);
  assert.equal(canExecuteAutomaticPromptSuspension({ action, details: { ...details, verifiedPromptAttemptCount: 15 }, env: enabledEnv }), false);
  assert.equal(canExecuteAutomaticPromptSuspension({ action, details: { ...details, companyId: null }, env: enabledEnv }), false);
  assert.equal(canExecuteAutomaticPromptSuspension({ action: { is_automated: false }, details, env: enabledEnv }), false);
});

test('worker counts exact user/company verified events with configurable window and never uses IP-only prompt totals', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'securityWorker.js'), 'utf8');
  assert.match(worker, /event_type = \$1[\s\S]*user_id::text = \$2[\s\S]*company_id::text = \$3/);
  assert.match(worker, /metadata->>'isSecurityThreat' = 'true'/);
  assert.match(worker, /NOW\(\) - \(\$4::int \* INTERVAL '1 minute'\)/);
  assert.match(worker, /\$1 = 'PROMPT_INJECTION'[\s\S]*company_id::text = \$4 AND target_user_id::text = \$3/);
});

test('worker queue handoff and agent diagnostics are present in source', () => {
  const emitter = fs.readFileSync(path.join(__dirname, '..', 'utils', 'securityEmitter.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.routes.js'), 'utf8');
  const aiData = fs.readFileSync(path.join(__dirname, '..', 'services', 'aiDataService.js'), 'utf8');
  assert.match(emitter, /eventType === SECURITY_EVENT_TYPES\.PROMPT_INJECTION/);
  assert.match(emitter, /trigger: 'prompt_injection_event'/);
  assert.match(route, /databaseMessage = String\(error\.message/);
  assert.match(aiData, /to_jsonb\(u\)->>'status'/);
  assert.doesNotMatch(aiData, /COALESCE\(status,\s*'active'\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'utils', 'securityPolicyEngine.js'), 'utf8'), /verifiedAttempts >= policy\.threshold/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'utils', 'securityPolicyEngine.js'), 'utf8'), /RULE_PROMPT_INJECTION_IP_THROTTLE|RULE_PROMPT_INJECTION_SESSION_REVOCATION/);
});
