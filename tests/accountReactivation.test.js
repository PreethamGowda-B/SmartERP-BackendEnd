'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reactivateStaffAccount, accountStateLockKey } = require('../services/accountReactivation');
const { isUserAccountActive, verifyAccessAccountState } = require('../middleware/authAccountState');

function setup({ account = { id: 'target-id', name: 'Target', email: 'target@example.test', role: 'employee', is_active: false, company_id: '2', account_status: 'suspended' }, hasStatus = true, actions = [] } = {}) {
  const sqlCalls = [];
  const redisCalls = [];
  let committed = false;
  const client = {
    async query(sql, params = []) {
      const query = String(sql).replace(/\s+/g, ' ').trim();
      sqlCalls.push({ query, params });
      if (query === 'BEGIN') return { rows: [] };
      if (query === 'COMMIT') { committed = true; return { rows: [] }; }
      if (query === 'ROLLBACK') return { rows: [] };
      if (query.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (query.startsWith('SELECT id::text, name, email, role, is_active')) return { rows: account ? [account] : [] };
      if (query.includes('information_schema.columns')) return { rows: [{ present: hasStatus }] };
      if (query.includes("UPDATE users SET is_active = TRUE, status = 'active'")) {
        return { rows: [{ ...account, is_active: true, account_status: 'active' }] };
      }
      if (query.includes('UPDATE users SET is_active = TRUE')) {
        return { rows: [{ ...account, is_active: true, account_status: 'active' }] };
      }
      if (query.startsWith('SELECT id, approval_status, details FROM security_actions')) return { rows: actions };
      if (query.startsWith('UPDATE security_actions')) return { rows: [] };
      if (query.startsWith('UPDATE refresh_tokens')) return { rows: [] };
      if (query.startsWith('INSERT INTO activities')) return { rows: [{ created_at: new Date(0) }] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() { sqlCalls.push({ query: 'RELEASE', params: [] }); },
  };
  const pool = { async connect() { return client; } };
  const redisClient = {
    status: 'ready',
    async set(...args) { redisCalls.push(['set', ...args]); },
    async del(...args) { redisCalls.push(['del', ...args]); },
  };
  return { pool, redisClient, sqlCalls, redisCalls, committed: () => committed };
}

test('Super Admin reactivation updates account state, preserves revoked sessions, and audits the actor and reason', async () => {
  const actions = [
    { id: 'pending-action', approval_status: 'pending', details: { userId: 'target-id', reason: 'review required' } },
    { id: 'executed-action', approval_status: 'executed', details: { userId: 'target-id', reason: 'policy suspension', executionDetails: { suspendedUserId: 'target-id' } } },
  ];
  const mocks = setup({ actions });
  const result = await reactivateStaffAccount({
    ...mocks, userId: 'target-id', actorId: 'admin-id', reason: 'False positive reviewed', now: 100000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.account.is_active, true);
  assert.equal(result.account.account_status, 'active');
  assert.equal(mocks.committed(), true);
  assert.ok(mocks.sqlCalls.some(({ query, params }) => query.includes('pg_advisory_xact_lock') && params[0] === accountStateLockKey('target-id')));
  assert.ok(mocks.sqlCalls.some(({ query }) => query.includes("status = 'active'")));
  assert.ok(mocks.sqlCalls.some(({ query, params }) => query.startsWith('UPDATE refresh_tokens') && params[0] === 'target-id'));
  const resolutionUpdates = mocks.sqlCalls.filter(({ query }) => query.startsWith('UPDATE security_actions'));
  assert.deepEqual(resolutionUpdates.map(({ params }) => params[0]), ['cancelled', 'reverted']);
  const audit = mocks.sqlCalls.find(({ query }) => query.startsWith('INSERT INTO activities'));
  assert.equal(audit.params[0], 'admin-id');
  assert.deepEqual(JSON.parse(audit.params[1]), {
    target_user_id: 'target-id', reason: 'False positive reviewed', resolution: 'reactivated',
    security_action_ids: ['pending-action', 'executed-action'],
  });
  assert.ok(mocks.redisCalls.some((call) => call[0] === 'set' && call[1] === 'token_revoked:target-id'));
  assert.ok(mocks.redisCalls.some((call) => call[0] === 'del' && call[1] === 'user_suspended:target-id'));
  assert.ok(!mocks.redisCalls.some((call) => call[0] === 'del' && call[1] === 'token_revoked:target-id'));
});

test('legacy users schema without status is supported without assuming the optional column', async () => {
  const mocks = setup({ hasStatus: false, account: { id: 'target-id', role: 'employee', is_active: false, account_status: 'active' } });
  const result = await reactivateStaffAccount({ ...mocks, userId: 'target-id', actorId: 'admin-id', reason: 'Reviewed and approved' });
  assert.equal(result.ok, true);
  assert.ok(mocks.sqlCalls.some(({ query }) => query.startsWith('UPDATE users SET is_active = TRUE WHERE')));
  assert.ok(!mocks.sqlCalls.some(({ query }) => query.includes('SET is_active = TRUE, status =')));
});

test('reactivated account can obtain fresh credentials while pre-reactivation sessions stay revoked', async () => {
  const activeAccount = { is_active: true, status: 'active' };
  assert.equal(isUserAccountActive(activeAccount), true, 'password and Google login status check accepts the reactivated account');

  const redisClient = {
    status: 'ready',
    async get(key) { return key === 'token_revoked:user-1' ? '100000' : null; },
    async set() {},
  };
  const pool = { async query() { return { rows: [activeAccount] }; } };
  assert.deepEqual(await verifyAccessAccountState({ pool, redisClient, userId: 'user-1', tokenIssuedAt: 99 }), {
    allowed: false, reason: 'session_revoked',
  });
  assert.deepEqual(await verifyAccessAccountState({ pool, redisClient, userId: 'user-1', tokenIssuedAt: 101 }), {
    allowed: true, reason: null,
  });
});

test('self-reactivation and unavailable Redis are refused safely; another disabled Super Admin can be restored', async () => {
  const self = setup();
  assert.equal((await reactivateStaffAccount({ ...self, userId: 'admin-id', actorId: 'ADMIN-ID', reason: 'Reviewed properly' })).code, 'SELF_REACTIVATION_FORBIDDEN');
  assert.equal(self.sqlCalls.length, 0);

  const superAdmin = setup({ account: { id: 'target-id', role: 'super_admin', is_active: false, account_status: 'suspended' } });
  assert.equal((await reactivateStaffAccount({ ...superAdmin, userId: 'target-id', actorId: 'admin-id', reason: 'Reviewed properly' })).ok, true);

  const noRedis = setup();
  assert.equal((await reactivateStaffAccount({ ...noRedis, redisClient: null, userId: 'target-id', actorId: 'admin-id', reason: 'Reviewed properly' })).code, 'SESSION_STORE_UNAVAILABLE');
  assert.equal(noRedis.sqlCalls.length, 0);
});

test('account security routes remain Super Admin-only and stale suspension approvals use compare-and-set', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  const security = fs.readFileSync(path.join(__dirname, '..', 'routes', 'security.js'), 'utf8');
  const executor = fs.readFileSync(path.join(__dirname, '..', 'utils', 'securityActionExecutor.js'), 'utf8');
  assert.match(admin, /router\.use\(authenticateToken\);\s*router\.use\(authenticateSuperAdmin\);/);
  assert.match(admin, /router\.post\('\/users\/:id\/restore'/);
  assert.match(admin, /SELF_REACTIVATION_FORBIDDEN/);
  assert.match(security, /WHERE id = \$2 AND approval_status = 'pending' RETURNING id/);
  assert.match(executor, /accountStateLockKey\(userId\)/);
  assert.match(executor, /Suspension action is no longer executable/);
});

test('Super Admin authorization middleware returns 401 and 403 before an account action can run', () => {
  const { authenticateSuperAdmin } = require('../middleware/adminMiddleware');
  const emitter = require('../utils/securityEmitter');
  const originalEmit = emitter.emitSecurityEvent;
  emitter.emitSecurityEvent = () => {};
  const invoke = (user) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    let nextCalled = false;
    authenticateSuperAdmin({ user, method: 'POST', path: '/users/id/restore' }, res, () => { nextCalled = true; });
    return { res, nextCalled };
  };
  try {
    assert.equal(invoke(null).res.statusCode, 401);
    assert.equal(invoke({ id: 'employee-id', role: 'employee' }).res.statusCode, 403);
    assert.equal(invoke({ id: 'admin-id', role: 'super_admin' }).nextCalled, true);
  } finally {
    emitter.emitSecurityEvent = originalEmit;
  }
});
