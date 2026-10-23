'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { storage } = require('../middleware/als');
const { transferOwnership } = require('../services/accountOwnershipTransfer');

const base = {
  currentUserId: 'owner-a',
  companyId: 'company-a',
  newOwnerId: 'employee-a',
  password: 'correct-password',
};

function mockPool({ currentOwner = true, target = true, company = true } = {}) {
  const calls = [];
  let checkoutContext;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (sql.includes('SELECT password_hash FROM users')) {
        return { rows: currentOwner ? [{ password_hash: 'hash' }] : [] };
      }
      if (sql.includes('SELECT id FROM users')) return { rows: target ? [{ id: base.newOwnerId }] : [] };
      if (sql.includes("UPDATE users SET role='owner'")) return { rowCount: 1, rows: [] };
      if (sql.includes("UPDATE users SET role='employee'")) return { rowCount: 1, rows: [] };
      if (sql.includes('UPDATE companies SET owner_id')) return { rowCount: company === 'ambiguous' ? 2 : company ? 1 : 0, rows: [] };
      throw new Error(`Unexpected query in unit test: ${sql}`);
    },
    release() {},
  };
  return {
    calls,
    pool: {
      async connect() {
        checkoutContext = storage.getStore();
        return client;
      },
    },
    getCheckoutContext: () => checkoutContext,
  };
}

test('ownership transfer uses a narrow explicit bypass and company-scopes every identity mutation', async () => {
  const mocked = mockPool();
  await storage.run({ isWebRequest: true, bypassRls: false }, async () => {
    assert.equal(storage.getStore().bypassRls, false);
    await transferOwnership({
      ...base,
      pool: mocked.pool,
      storage,
      bcrypt: { async compare(password, hash) { return password === base.password && hash === 'hash'; } },
    });
    assert.equal(storage.getStore().bypassRls, false);
  });

  assert.equal(mocked.getCheckoutContext().bypassRls, true);
  const mutations = mocked.calls.filter(({ sql }) => sql.startsWith('UPDATE'));
  assert.equal(mutations.length, 3);
  assert.ok(mutations.every(({ sql, params }) => sql.includes('company_id::text=$2::text') || sql.includes('id::text=$2::text') || sql.includes('company_id::text=$2::text')));
  assert.ok(mutations.some(({ params }) => params.includes(base.companyId)));
  assert.equal(mocked.calls.at(-1).sql, 'COMMIT');
});

test('a stale owner token cannot transfer ownership after database role demotion', async () => {
  const mocked = mockPool({ currentOwner: false });
  await assert.rejects(
    transferOwnership({ ...base, pool: mocked.pool, storage, bcrypt: { async compare() { assert.fail('password should not be checked'); } } }),
    { statusCode: 403 }
  );
  assert.equal(mocked.calls.some(({ sql }) => sql.startsWith('UPDATE')), false);
  assert.equal(mocked.calls.at(-1).sql, 'ROLLBACK');
});

test('a target outside the authenticated company cannot be promoted', async () => {
  const mocked = mockPool({ target: false });
  await assert.rejects(
    transferOwnership({ ...base, pool: mocked.pool, storage, bcrypt: { async compare() { return true; } } }),
    { statusCode: 404 }
  );
  assert.equal(mocked.calls.some(({ sql }) => sql.startsWith('UPDATE')), false);
  const targetQuery = mocked.calls.find(({ sql }) => sql.includes('SELECT id FROM users'));
  assert.match(targetQuery.sql, /company_id::text=\$2::text/);
  assert.ok(targetQuery.params.includes(base.companyId));
  assert.equal(mocked.calls.at(-1).sql, 'ROLLBACK');
});

test('a missing company ownership row rolls back both role changes', async () => {
  const mocked = mockPool({ company: false });
  await assert.rejects(
    transferOwnership({ ...base, pool: mocked.pool, storage, bcrypt: { async compare() { return true; } } }),
    /Company ownership record was missing or ambiguous/
  );
  assert.equal(mocked.calls.at(-1).sql, 'ROLLBACK');
});

test('ambiguous company identity match rolls back the ownership transfer', async () => {
  const mocked = mockPool({ company: 'ambiguous' });
  await assert.rejects(
    transferOwnership({ ...base, pool: mocked.pool, storage, bcrypt: { async compare() { return true; } } }),
    /Company ownership record was missing or ambiguous/
  );
  assert.equal(mocked.calls.at(-1).sql, 'ROLLBACK');
});
