'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../services/aiConversationPolicy');

test('conversation ownership requires matching authenticated user and company', () => {
  const conversation = { id: 'thread-a', companyId: 'company-a', ownerUserId: 'user-a' };
  assert.deepEqual(policy.assertConversationOwner({ user: { id: 'user-a', company_id: 'company-a' }, conversation }), {
    userId: 'user-a', companyId: 'company-a',
  });
  assert.throws(() => policy.assertConversationOwner({ user: { id: 'user-b', companyId: 'company-a' }, conversation }), {
    statusCode: 404, code: 'AI_CONVERSATION_NOT_FOUND',
  });
  assert.throws(() => policy.assertConversationOwner({ user: { id: 'user-a', companyId: 'company-b' }, conversation }), {
    statusCode: 404, code: 'AI_CONVERSATION_NOT_FOUND',
  });
  assert.throws(() => policy.assertConversationOwner({ user: { id: 'user-a' }, conversation }), {
    statusCode: 401, code: 'AI_CONVERSATION_AUTH_CONTEXT_REQUIRED',
  });
});

test('conversation pagination is bounded and retention dates are deterministic', () => {
  assert.deepEqual(policy.normalizeConversationPage({ page: '3', limit: '20' }), { page: 3, limit: 20, offset: 40 });
  assert.throws(() => policy.normalizeConversationPage({ page: 1, limit: 101 }), { code: 'AI_CONVERSATION_PAGINATION_INVALID' });
  assert.throws(() => policy.normalizeConversationPage({ page: '2junk', limit: 20 }), { code: 'AI_CONVERSATION_PAGINATION_INVALID' });
  assert.throws(() => policy.normalizeConversationPage({ page: Number.MAX_SAFE_INTEGER, limit: 100 }), { code: 'AI_CONVERSATION_PAGINATION_INVALID' });
  assert.equal(policy.getRetentionCutoff({ now: '2026-10-23T00:00:00.000Z', retentionDays: 30 }).toISOString(), '2026-09-23T00:00:00.000Z');
  assert.throws(() => policy.getRetentionCutoff({ retentionDays: 0 }), { code: 'AI_CONVERSATION_RETENTION_INVALID' });
});
