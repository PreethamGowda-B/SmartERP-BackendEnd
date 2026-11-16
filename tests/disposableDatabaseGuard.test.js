'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareDisposableDatabaseTest,
  verifyDisposableDatabaseTest,
} = require('./helpers/disposableDatabaseGuard');

const safeEnv = {
  NODE_ENV: 'test',
  SMARTERP_ENVIRONMENT: 'isolated_test',
  SMARTERP_DISPOSABLE_TEST_DB: 'true',
  DATABASE_URL: 'postgresql://app_role:app_pw@db.prodprojectref123.supabase.co:5432/smarterp_prod',
  TEST_DATABASE_URL: 'postgresql://smarterp_test_runner:test_pw@db.testprojectref123.supabase.co:5432/smarterp_isolated_test',
  TEST_DATABASE_PROJECT_REF: 'testprojectref123',
  TEST_DATABASE_ROLE: 'smarterp_test_runner',
  TEST_DATABASE_ISOLATION_TOKEN: 'isolated-test-token-1234567890',
  TEST_DATABASE_AUTHORIZATION: 'AUTHORIZED_BY_OWNER_FOR_TESTING',
};

test('destructive database tests skip without explicit disposable database opt-in', () => {
  const gate = prepareDisposableDatabaseTest({
    env: { ...safeEnv, SMARTERP_DISPOSABLE_TEST_DB: undefined },
    applyToProcess: false,
  });
  assert.equal(gate.enabled, false);
  assert.match(gate.reason, /SMARTERP_DISPOSABLE_TEST_DB=true/);
});

test('database guard rejects ambiguous, production, and default database targets', () => {
  for (const env of [
    { ...safeEnv, TEST_DATABASE_URL: undefined },
    { ...safeEnv, TEST_DATABASE_URL: 'postgresql://smarterp_test_runner:test_pw@db.prodprojectref123.supabase.co:5432/smarterp_isolated_test' },
    { ...safeEnv, TEST_DATABASE_URL: 'postgresql://smarterp_test_runner:test_pw@db.testprojectref123.supabase.co:5432/postgres' },
    { ...safeEnv, TEST_DATABASE_ROLE: 'postgres' },
  ]) {
    assert.equal(prepareDisposableDatabaseTest({ env, applyToProcess: false }).enabled, false);
  }
});

test('database guard requires live matching database identity, role privileges, and marker', async () => {
  const gate = prepareDisposableDatabaseTest({ env: safeEnv, applyToProcess: false });
  assert.equal(gate.enabled, true);
  const pool = {
    async query(sql) {
      if (sql.includes('current_database()')) return { rows: [{ database_name: 'smarterp_isolated_test', database_role: 'smarterp_test_runner' }] };
      if (sql.includes('pg_roles')) return { rows: [{ rolname: 'smarterp_test_runner', rolsuper: false, rolbypassrls: false }] };
      if (sql.includes('smarterp_test_database_identity')) return { rows: [{
        environment: 'isolated_test',
        project_ref: 'testprojectref123',
        database_name: 'smarterp_isolated_test',
        database_role: 'smarterp_test_runner',
        isolation_token: 'isolated-test-token-1234567890',
      }] };
      throw new Error('unexpected query');
    },
  };
  const result = await verifyDisposableDatabaseTest(pool, gate);
  assert.equal(result.status, 'PASS');
  assert.equal(result.isolated, true);
});
