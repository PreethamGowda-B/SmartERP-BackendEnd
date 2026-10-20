const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePoolMax, DEFAULT_DB_POOL_MAX } = require('../db-base');

test('database pool defaults to four clients per process for the session-pool budget', () => {
  assert.equal(DEFAULT_DB_POOL_MAX, 4);
  assert.equal(resolvePoolMax(undefined), 4);
  assert.equal(resolvePoolMax(''), 4);
});

test('database pool accepts a valid explicit pool limit', () => {
  assert.equal(resolvePoolMax('3'), 3);
  assert.equal(resolvePoolMax('8'), 8);
});

test('database pool falls back safely for invalid or non-positive limits', () => {
  assert.equal(resolvePoolMax('not-a-number'), 4);
  assert.equal(resolvePoolMax('0'), 4);
  assert.equal(resolvePoolMax('-2'), 4);
});
