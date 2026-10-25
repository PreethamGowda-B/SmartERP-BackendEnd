'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isUserAccountActive, verifyAccessAccountState } = require('../middleware/authAccountState');

function accountPool(row = { is_active: true }) {
  return {
    async query(sql, params) {
      assert.equal(sql, "SELECT is_active, COALESCE(NULLIF(to_jsonb(u)->>'status', ''), 'active') AS status FROM users u WHERE id = $1");
      assert.deepEqual(params, ['user-1']);
      return { rows: row ? [row] : [] };
    },
  };
}

test('only explicitly active user state is authoritative for password and protected access checks', () => {
  assert.equal(isUserAccountActive({ is_active: false }), false);
  assert.equal(isUserAccountActive({ is_active: true }), true);
  assert.equal(isUserAccountActive({ is_active: 'true' }), true);
  assert.equal(isUserAccountActive({ is_active: true, status: 'inactive' }), false);
  assert.equal(isUserAccountActive({ is_active: true, status: 'suspended' }), false);
  assert.equal(isUserAccountActive({}), false);
  assert.equal(isUserAccountActive(null), false);
});

test('protected account check denies deactivated and missing users', async () => {
  const inactive = await verifyAccessAccountState({
    pool: accountPool({ is_active: false }), userId: 'user-1', tokenIssuedAt: 100,
  });
  const missing = await verifyAccessAccountState({
    pool: accountPool(null), userId: 'user-1', tokenIssuedAt: 100,
  });
  assert.deepEqual(inactive, { allowed: false, reason: 'user_inactive' });
  assert.deepEqual(missing, { allowed: false, reason: 'user_missing' });
});

test('protected account check rejects an access token issued before forced logout', async () => {
  const state = await verifyAccessAccountState({
    pool: accountPool(),
    redisClient: {
      status: 'ready',
      async get(key) {
        if (key === 'user_suspended:user-1' || key === 'user_active:user-1') return null;
        assert.equal(key, 'token_revoked:user-1');
        return '100000';
      },
    },
    userId: 'user-1',
    tokenIssuedAt: 100,
  });
  assert.deepEqual(state, { allowed: false, reason: 'session_revoked' });
});

test('independent Redis security checks run concurrently without weakening access decisions', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const keys = [];
  const state = await verifyAccessAccountState({
    pool: { async query() { throw new Error('cached active state should avoid database lookup'); } },
    redisClient: {
      status: 'ready',
      async get(key) {
        keys.push(key);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return key === 'user_active:user-1' ? '1' : null;
      },
    },
    userId: 'user-1',
    tokenIssuedAt: 100,
  });

  assert.deepEqual(state, { allowed: true, reason: null });
  assert.deepEqual(keys.sort(), [
    'token_revoked:user-1',
    'user_active:user-1',
    'user_suspended:user-1',
  ]);
  assert.equal(maxInFlight, 3, 'Redis round trips should overlap instead of running serially');
});

test('protected account check accepts a new token issued after the revocation timestamp', async () => {
  const state = await verifyAccessAccountState({
    pool: accountPool(),
    redisClient: {
      status: 'ready',
      async get(key) { return key === 'token_revoked:user-1' ? '100000' : null; },
    },
    userId: 'user-1',
    tokenIssuedAt: 101,
  });
  assert.deepEqual(state, { allowed: true, reason: null });
});

test('protected account check propagates database errors and falls back to the database when Redis is unavailable', async () => {
  await assert.rejects(verifyAccessAccountState({
    pool: { async query() { throw new Error('database offline'); } }, userId: 'user-1', tokenIssuedAt: 100,
  }), /database offline/);
  const redisUnavailable = await verifyAccessAccountState({
    pool: accountPool(),
    redisClient: { status: 'ready', async get() { throw new Error('redis offline'); } },
    userId: 'user-1', tokenIssuedAt: 100,
  });
  assert.deepEqual(redisUnavailable, { allowed: true, reason: null });
});

test('account-state query treats status as an optional legacy column while keeping is_active mandatory', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [{ is_active: true, status: 'active' }] };
    },
  };

  const result = await verifyAccessAccountState({ pool, userId: 'user-1', tokenIssuedAt: 100 });
  assert.deepEqual(result, { allowed: true, reason: null });
  assert.match(queries[0].sql, /SELECT is_active,/);
  assert.match(queries[0].sql, /to_jsonb\(u\)->>'status'/);
  assert.doesNotMatch(queries[0].sql, /SELECT\s+is_active\s*,\s*(?:u\.)?status\b/i);
  assert.doesNotMatch(queries[0].sql, /u\.status\b/i);
  assert.doesNotMatch(queries[0].sql, /\brole\b/i);
  assert.deepEqual(queries[0].params, ['user-1']);
});

test('simultaneous cold-cache checks for one user share an in-flight database lookup', async () => {
  let queryCount = 0;
  let finishQuery;
  const pool = {
    query() {
      queryCount += 1;
      if (queryCount > 1) return Promise.resolve({ rows: [{ is_active: true, status: 'active' }] });
      return new Promise((resolve) => { finishQuery = resolve; });
    },
  };
  const check = () => verifyAccessAccountState({ pool, userId: 'same-user', tokenIssuedAt: 100 });

  const first = check();
  const second = check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queryCount, 1);
  finishQuery({ rows: [{ is_active: true, status: 'active' }] });
  assert.deepEqual(await Promise.all([first, second]), [
    { allowed: true, reason: null },
    { allowed: true, reason: null },
  ]);

  await check();
  assert.equal(queryCount, 2, 'completed account state is not cached in process');
});

test('password login, refresh, and protected requests enforce persisted account state', () => {
  const authRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const authMiddleware = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'authMiddleware.js'), 'utf8');
  assert.match(authRoute, /if \(!isUserAccountActive\(user\)\)/);
  assert.match(authRoute, /SELECT id, role, email, company_id, is_active FROM users/);
  assert.match(authMiddleware, /verifyAccessAccountState/);
  assert.match(authMiddleware, /return res\.status\(503\)\.json\(\{ message: 'Unable to verify account status/);
});

test('approved company suspension uses the same status field that authentication checks', () => {
  const executor = fs.readFileSync(path.join(__dirname, '..', 'utils', 'securityActionExecutor.js'), 'utf8');
  const middleware = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'authMiddleware.js'), 'utf8');
  assert.match(executor, /UPDATE companies SET status = 'suspended'/);
  assert.doesNotMatch(executor, /companies SET is_suspended/);
  assert.match(middleware, /SELECT status, COALESCE\(NULLIF\(to_jsonb\(c\)->>'is_suspended'/);
});
