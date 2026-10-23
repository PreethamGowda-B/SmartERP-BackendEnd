const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_SCOPES_BY_TIER, resolveAiModelScopes } = require('../services/aiModelEntitlements');
const { PLAN_FEATURES } = require('../services/subscriptionCatalog');

test('Starter has the basic assistant while plans add model choices, not message counts', () => {
  assert.equal(PLAN_FEATURES.starter.ai_assistant, true);
  assert.deepEqual(MODEL_SCOPES_BY_TIER.starter, ['general']);
  assert.deepEqual(MODEL_SCOPES_BY_TIER.professional, ['general', 'cnc', 'inventory', 'attendance', 'hr']);
  assert.deepEqual(MODEL_SCOPES_BY_TIER.enterprise, ['general', 'cnc', 'finance', 'inventory', 'attendance', 'payroll', 'hr', 'gst', 'executive']);
});

test('manual specialist selection is enforced from the backend plan', () => {
  assert.deepEqual(resolveAiModelScopes({ planTier: 'starter', requestedScopes: ['general'] }), {
    ok: true, scopes: ['general'], autoSelectedModel: null,
  });
  assert.equal(resolveAiModelScopes({ planTier: 'starter', requestedScopes: ['finance'] }).code, 'AI_MODEL_NOT_INCLUDED');
  assert.equal(resolveAiModelScopes({ planTier: 'professional', requestedScopes: ['payroll'] }).status, 403);
  assert.deepEqual(resolveAiModelScopes({ planTier: 'professional', requestedScopes: ['cnc'] }).scopes, ['cnc']);
  assert.deepEqual(resolveAiModelScopes({ planTier: 'enterprise', requestedScopes: ['payroll', 'finance'] }).scopes, ['payroll', 'finance']);
  assert.equal(resolveAiModelScopes({ planTier: 'enterprise', requestedScopes: ['security'] }).code, 'AI_MODEL_SELECTION_INVALID');
});

test('auto mode falls back to an included model when its detected specialist is not entitled', () => {
  const detectModelScope = () => 'finance';
  assert.deepEqual(resolveAiModelScopes({ planTier: 'starter', prompt: 'revenue', detectModelScope }), {
    ok: true, scopes: ['general'], autoSelectedModel: 'general',
  });
  assert.deepEqual(resolveAiModelScopes({ planTier: 'professional', prompt: 'revenue', detectModelScope }), {
    ok: true, scopes: ['general'], autoSelectedModel: 'general',
  });
  assert.deepEqual(resolveAiModelScopes({ planTier: 'enterprise', prompt: 'revenue', detectModelScope }), {
    ok: true, scopes: ['finance'], autoSelectedModel: 'finance',
  });
});

test('AI routes no longer consume per-hour quotas or apply keyword-based enterprise topic blocks', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.routes.js'), 'utf8');
  const copilot = fs.readFileSync(path.join(__dirname, '..', 'routes', 'businessCopilot.js'), 'utf8');
  assert.doesNotMatch(source, /enforceAIRequestQuota|consumeAIRequest|checkEnterpriseCapabilityKeyword/);
  assert.doesNotMatch(copilot, /requireAIQuota|consumeAIRequest/);
});
