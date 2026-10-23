'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getVerifiedPromptEvidence, THREAT_CATEGORIES } = require('../jobs/securityWorker');
const { evaluatePolicyForIncident, SECURITY_ACTION_TYPES } = require('../utils/securityPolicyEngine');

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

test('three verified attempts allow reversible containment, while suspension still requires stronger corroboration and approval', () => {
  const repeated = evaluatePolicyForIncident({
    threat_category: THREAT_CATEGORIES.PROMPT_INJECTION,
    risk_score: 95,
    source_ip: '192.0.2.10',
    target_user_id: 'u1',
    company_id: 'c1',
    ai_analysis: { verifiedPromptAttemptCount: 3, verifiedPromptCategories: ['SYSTEM_INSTRUCTION_OVERRIDE'] },
  });
  assert.deepEqual(repeated.map((action) => action.actionType), [
    SECURITY_ACTION_TYPES.IP_THROTTLE_TEMPORARY,
    SECURITY_ACTION_TYPES.SESSION_REVOKE_TARGET,
  ]);

  const corroborated = evaluatePolicyForIncident({
    threat_category: THREAT_CATEGORIES.PROMPT_INJECTION,
    risk_score: 95,
    source_ip: '192.0.2.10',
    target_user_id: 'u1',
    company_id: 'c1',
    ai_analysis: { verifiedPromptAttemptCount: 5, verifiedPromptCategories: ['SYSTEM_INSTRUCTION_OVERRIDE', 'CREDENTIAL_EXFILTRATION'] },
  });
  const suspension = corroborated.find((action) => action.actionType === SECURITY_ACTION_TYPES.USER_SUSPEND);
  assert.ok(suspension);
  assert.equal(suspension.isAutomated, false);
  assert.equal(suspension.requiresApproval, true);
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
});
