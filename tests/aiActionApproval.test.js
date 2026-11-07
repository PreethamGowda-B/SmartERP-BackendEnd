'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createApprovalToken, consumeApprovalToken } = require('../services/aiActionApproval');

const scope = {
  userId: 'user-1',
  companyId: 'company-1',
  action: 'create_service_job',
  payload: { workflowType: 'breakdown_flow', job: { title: 'Breakdown', serviceType: 'breakdown', priority: 'high' } },
};

test('AI approval is bound to user, tenant, action, and exact payload and is single-use', async () => {
  const token = createApprovalToken(scope, 'test-secret-that-is-at-least-32-characters');
  const consumedKeys = new Set();
  const redisClient = {
    async set(key, _value, nx, ex, ttl) {
      assert.equal(nx, 'NX');
      assert.equal(ex, 'EX');
      assert.equal(ttl, 300);
      if (consumedKeys.has(key)) return null;
      consumedKeys.add(key);
      return 'OK';
    },
  };
  await assert.rejects(consumeApprovalToken(token, { ...scope, userId: 'user-2', redisClient, secret: 'test-secret-that-is-at-least-32-characters' }),
    (error) => error.code === 'AI_APPROVAL_SCOPE_MISMATCH');
  await assert.rejects(consumeApprovalToken(token, { ...scope, payload: { ...scope.payload, job: { ...scope.payload.job, priority: 'low' } }, redisClient, secret: 'test-secret-that-is-at-least-32-characters' }),
    (error) => error.code === 'AI_APPROVAL_SCOPE_MISMATCH');
  await consumeApprovalToken(token, { ...scope, redisClient, secret: 'test-secret-that-is-at-least-32-characters' });
  await assert.rejects(consumeApprovalToken(token, { ...scope, redisClient, secret: 'test-secret-that-is-at-least-32-characters' }),
    (error) => error.code === 'AI_APPROVAL_ALREADY_USED');
});

test('AI approval rejects a token signed with a different secret', async () => {
  const token = createApprovalToken(scope, 'test-secret-that-is-at-least-32-characters');
  await assert.rejects(consumeApprovalToken(token, {
    ...scope,
    redisClient: { async set() { return 'OK'; } },
    secret: 'a-different-test-secret-with-enough-length',
  }), (error) => error.code === 'AI_APPROVAL_INVALID');
});

test('AI approval rejects wrong company and action before touching Redis', async () => {
  const secret = 'test-secret-that-is-at-least-32-characters';
  const token = createApprovalToken(scope, secret);
  let redisCalls = 0;
  const redisClient = { async set() { redisCalls += 1; return 'OK'; } };
  for (const mismatch of [
    { companyId: 'company-2' },
    { action: 'delete_job' },
  ]) {
    await assert.rejects(consumeApprovalToken(token, {
      ...scope, ...mismatch, redisClient, secret,
    }), (error) => error.code === 'AI_APPROVAL_SCOPE_MISMATCH');
  }
  assert.equal(redisCalls, 0);
});

test('AI approval rejects expired tokens and fails closed when Redis is unavailable', async () => {
  const secret = 'test-secret-that-is-at-least-32-characters';
  const expiredToken = jwt.sign({
    sub: scope.userId,
    companyId: scope.companyId,
    action: scope.action,
    payloadHash: require('../services/aiActionApproval').stableHash(scope.payload),
    jti: 'expired-test-token',
  }, secret, { algorithm: 'HS256', expiresIn: -1, issuer: 'smarterp-ai', audience: 'smarterp-ai-action' });
  await assert.rejects(consumeApprovalToken(expiredToken, {
    ...scope, redisClient: { async set() { return 'OK'; } }, secret,
  }), (error) => error.code === 'AI_APPROVAL_INVALID');

  const validToken = createApprovalToken(scope, secret);
  await assert.rejects(consumeApprovalToken(validToken, { ...scope, redisClient: null, secret }),
    (error) => error.code === 'AI_APPROVAL_STORE_UNAVAILABLE');
  await assert.rejects(consumeApprovalToken(validToken, {
    ...scope, redisClient: { async set() { throw new Error('offline'); } }, secret,
  }), (error) => error.code === 'AI_APPROVAL_STORE_UNAVAILABLE');
});

test('concurrent confirmation with one approval token permits exactly one write', async () => {
  const secret = 'test-secret-that-is-at-least-32-characters';
  const token = createApprovalToken(scope, secret);
  const consumed = new Set();
  let writes = 0;
  const redisClient = {
    async set(key) {
      if (consumed.has(key)) return null;
      consumed.add(key);
      return 'OK';
    },
  };
  const confirmations = await Promise.allSettled([1, 2].map(async () => {
    await consumeApprovalToken(token, { ...scope, redisClient, secret });
    writes += 1;
  }));
  assert.equal(confirmations.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(confirmations.filter((result) => result.status === 'rejected' && result.reason.code === 'AI_APPROVAL_ALREADY_USED').length, 1);
  assert.equal(writes, 1);
});
