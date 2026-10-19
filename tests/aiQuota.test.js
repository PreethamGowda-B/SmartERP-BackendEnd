const test = require('node:test');
const assert = require('node:assert/strict');
const { consumeAIRequest, AI_REQUESTS_PER_HOUR } = require('../services/aiQuota');

test('AI quota fails closed when Redis or authenticated user context is unavailable', async () => {
  assert.equal((await consumeAIRequest(null, 'u1', 'starter')).status, 503);
  assert.equal((await consumeAIRequest({ status: 'connecting' }, 'u1', 'starter')).status, 503);
  assert.equal((await consumeAIRequest({ status: 'ready', eval: async () => { throw new Error('offline'); } }, 'u1', 'starter')).status, 503);
  assert.equal((await consumeAIRequest({ status: 'ready', eval: async () => ['bad', 50] }, 'u1', 'starter')).status, 503);
  assert.equal((await consumeAIRequest({ status: 'ready', eval: async () => [1, 50] }, null, 'starter')).status, 503);
  assert.equal((await consumeAIRequest({ status: 'ready', eval: async () => [1, 50] }, 'u1', 'unknown')).status, 503);
});

test('AI quota uses one atomic Redis increment with plan-specific existing limits', async () => {
  const calls = [];
  const redis = {
    status: 'ready',
    eval: async (...args) => { calls.push(args); return [1, 3600]; }
  };
  assert.deepEqual(AI_REQUESTS_PER_HOUR, { starter: 5, professional: 15, enterprise: 30 });
  const outcome = await consumeAIRequest(redis, 'user-1', 'enterprise');
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.limit, 30);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].includes("redis.call('INCR'"), true);
  assert.equal(calls[0][0].includes("redis.call('EXPIRE'"), true);
  assert.equal(calls[0][2], 'ai_agent:user-1');
});

test('AI quota blocks requests above the selected tier limit and returns retry delay', async () => {
  const outcome = await consumeAIRequest({ status: 'ready', eval: async () => [6, 3210] }, 'u1', 'starter');
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.status, 429);
  assert.equal(outcome.limit, 5);
  assert.equal(outcome.retryAfter, 3210);
  assert.equal(outcome.count, 6);
});

