const test = require('node:test');
const assert = require('node:assert/strict');
const { consumeAIRequest } = require('../services/aiQuota');

test('AI message count is unlimited and does not depend on Redis or plan tier', async () => {
  let redisCalls = 0;
  const redis = { status: 'ready', eval: async () => { redisCalls += 1; throw new Error('must not be called'); } };

  for (const [client, userId, tier] of [
    [null, null, null],
    [{ status: 'connecting' }, 'user-1', 'starter'],
    [redis, 'user-1', 'professional'],
    [redis, 'user-1', 'enterprise'],
    [redis, 'user-1', 'unknown'],
  ]) {
    assert.deepEqual(await consumeAIRequest(client, userId, tier), {
      allowed: true,
      unlimited: true,
      limit: null,
      count: null,
    });
  }
  assert.equal(redisCalls, 0);
});
