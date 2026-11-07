'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MetricsService = require('../ai/telemetry/metrics.service');

test('approved-action audit params retain a payload digest and safe fields, not names or contact details', () => {
  const params = {
    name: 'Sensitive Person', email: 'person@example.test', phone: '+1 555 0100',
    title: 'Customer escalation', description: 'private details', priority: 'urgent',
  };
  const keyConfig = { key: 'unit-test-audit-key', keyId: 'unit-test-v1' };
  const serialized = JSON.stringify(MetricsService.approvalAuditParams('create_job', params, keyConfig));
  assert.ok(serialized.includes(MetricsService.keyedDigest('approved-action-payload', params, keyConfig.key)));
  assert.ok(serialized.includes('payload_hmac_sha256'));
  assert.equal(serialized.includes('payload_sha256'), false);
  assert.notEqual(
    MetricsService.keyedDigest('approved-action-payload', params, keyConfig.key),
    MetricsService.keyedDigest('approved-action-payload', params, 'different-key'),
  );
  assert.ok(serialized.includes('unit-test-v1'));
  assert.ok(serialized.includes('urgent'));
  for (const sensitive of ['Sensitive Person', 'person@example.test', '+1 555 0100', 'private details']) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

test('transactional audit inserts propagate database errors to the caller', async () => {
  const expected = new Error('audit insert failed');
  await assert.rejects(MetricsService.writeAIAuditEvent({
    queryable: { query: async () => { throw expected; } },
    userContext: { user: { id: 'u1', companyId: 'c1', role: 'owner' } },
    toolName: 'create_customer',
    params: { name: 'Private Name', email: 'private@example.test' },
  }), (error) => error === expected);
});

test('audit insert stores keyed fingerprints and bounded metadata instead of raw params, prompts, or error text', async () => {
  const previousKey = process.env.AI_AUDIT_HMAC_SECRET;
  process.env.AI_AUDIT_HMAC_SECRET = 'unit-test-audit-secret';
  let captured;
  try {
    await MetricsService.writeAIAuditEvent({
      queryable: { async query(_sql, values) { captured = values; return { rows: [] }; } },
      userContext: { user: { id: 'user-1', companyId: 'company-1', role: 'owner' } },
      toolName: 'create_customer',
      params: { name: 'Sensitive Name', email: 'person@example.test', token: 'secret-token' },
      promptPreview: 'Private payroll prompt text',
      error: Object.assign(new Error('database password should not be persisted'), { code: 'DB_FAILURE' }),
    });
  } finally {
    if (previousKey === undefined) delete process.env.AI_AUDIT_HMAC_SECRET;
    else process.env.AI_AUDIT_HMAC_SECRET = previousKey;
  }
  const actionParams = captured[4];
  assert.equal(actionParams.includes('Sensitive Name'), false);
  assert.equal(actionParams.includes('person@example.test'), false);
  assert.equal(actionParams.includes('secret-token'), false);
  assert.equal(captured[6].includes('password should not'), false);
  assert.equal(captured[14].includes('Private payroll prompt text'), false);
  assert.match(captured[14], /^hmac-sha256:/);
});
