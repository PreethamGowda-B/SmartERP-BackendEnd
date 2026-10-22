'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDatabaseUrl,
  assertTestConfiguration,
  assertDedicatedTestDatabaseName,
  verifyLiveDatabaseIdentity,
} = require('../scripts/paymentTestDatabasePreflight');

const validMockEnv = {
  NODE_ENV: 'test',
  SMARTERP_ENVIRONMENT: 'isolated_test',
  DATABASE_URL: 'postgresql://prod_user:secret_prod_pw@aws-0-prod.pooler.supabase.com:5432/postgres',
  TEST_DATABASE_URL: 'postgresql://smarterp_test_runner:secret_test_pw@aws-0-test.pooler.supabase.com:5432/postgres',
  TEST_DATABASE_PROJECT_REF: 'testprojectref123',
  TEST_DATABASE_ROLE: 'smarterp_test_runner',
  TEST_DATABASE_ISOLATION_TOKEN: 'token-abc1234567890-strictly-isolated',
  TEST_DATABASE_AUTHORIZATION: 'AUTHORIZED_BY_OWNER_FOR_TESTING',
};

test('preflight URL parser safely extracts components without exposing password', () => {
  const parsed = parseDatabaseUrl('postgresql://test_role:super_secret_pw@aws-0-ap.pooler.supabase.com:5432/my_test_db');
  assert.equal(parsed.host, 'aws-0-ap.pooler.supabase.com');
  assert.equal(parsed.port, '5432');
  assert.equal(parsed.database, 'my_test_db');
  assert.equal(parsed.role, 'test_role');
  assert.equal(Object.keys(parsed).includes('password'), false);
});

test('preflight rejects missing TEST_DATABASE_URL and forbids fallback to DATABASE_URL', () => {
  const env = { ...validMockEnv, TEST_DATABASE_URL: '' };
  assert.throws(
    () => assertTestConfiguration(env),
    (err) => err.message.includes('TEST_DATABASE_URL is missing. Production fallback is forbidden.')
  );
});

test('preflight rejects if TEST_DATABASE_URL targets production DATABASE_URL host/database', () => {
  const env = {
    ...validMockEnv,
    DATABASE_URL: 'postgresql://prod_role:pw1@aws-0-shared.pooler.supabase.com:5432/postgres',
    TEST_DATABASE_URL: 'postgresql://smarterp_test_runner:pw2@aws-0-shared.pooler.supabase.com:5432/postgres',
  };
  assert.throws(
    () => assertTestConfiguration(env),
    (err) => err.message.includes('FATAL SAFETY VIOLATION: TEST_DATABASE_URL targets the production/application database.')
  );
});

test('preflight rejects production environment or missing isolated_test environment marker', () => {
  assert.throws(
    () => assertTestConfiguration({ ...validMockEnv, NODE_ENV: 'production' }),
    (err) => err.message.includes('NODE_ENV is set to production')
  );
  assert.throws(
    () => assertTestConfiguration({ ...validMockEnv, SMARTERP_ENVIRONMENT: 'development' }),
    (err) => err.message.includes('SMARTERP_ENVIRONMENT must be explicitly set to "isolated_test"')
  );
});

test('preflight rejects missing owner authorization or short isolation tokens', () => {
  assert.throws(
    () => assertTestConfiguration({ ...validMockEnv, TEST_DATABASE_AUTHORIZATION: 'NO' }),
    (err) => err.message.includes('AUTHORIZED_BY_OWNER_FOR_TESTING')
  );
  assert.throws(
    () => assertTestConfiguration({ ...validMockEnv, TEST_DATABASE_ISOLATION_TOKEN: 'too-short' }),
    (err) => err.message.includes('must be at least 16 characters')
  );
});

test('preflight rejects default administrative superuser accounts as test role', () => {
  assert.throws(
    () => assertTestConfiguration({
      ...validMockEnv,
      TEST_DATABASE_URL: 'postgresql://postgres:pw@aws-0-test.pooler.supabase.com:5432/postgres',
      TEST_DATABASE_ROLE: 'postgres',
    }),
    (err) => err.message.includes('Test role cannot be the default administrative superuser')
  );
});

test('preflight rejects connected role with SUPERUSER or BYPASSRLS privileges', async () => {
  const mockSuperuserRunner = async (sql) => {
    if (sql.includes('current_database()')) {
      return { rows: [{ database_name: 'postgres', database_role: 'smarterp_test_runner' }] };
    }
    if (sql.includes('pg_roles')) {
      return { rows: [{ rolname: 'smarterp_test_runner', rolsuper: true, rolbypassrls: false }] };
    }
    return { rows: [] };
  };

  await assert.rejects(
    () => verifyLiveDatabaseIdentity({ env: validMockEnv, queryRunner: mockSuperuserRunner }),
    (err) => err.message.includes('Test database role has SUPERUSER privilege')
  );

  const mockBypassRlsRunner = async (sql) => {
    if (sql.includes('current_database()')) {
      return { rows: [{ database_name: 'postgres', database_role: 'smarterp_test_runner' }] };
    }
    if (sql.includes('pg_roles')) {
      return { rows: [{ rolname: 'smarterp_test_runner', rolsuper: false, rolbypassrls: true }] };
    }
    return { rows: [] };
  };

  await assert.rejects(
    () => verifyLiveDatabaseIdentity({ env: validMockEnv, queryRunner: mockBypassRlsRunner }),
    (err) => err.message.includes('Test database role has BYPASSRLS privilege')
  );
});

test('preflight rejects missing or mismatched in-database identity marker', async () => {
  const mockMissingMarkerRunner = async (sql) => {
    if (sql.includes('current_database()')) {
      return { rows: [{ database_name: 'postgres', database_role: 'smarterp_test_runner' }] };
    }
    if (sql.includes('pg_roles')) {
      return { rows: [{ rolname: 'smarterp_test_runner', rolsuper: false, rolbypassrls: false }] };
    }
    if (sql.includes('smarterp_test_database_identity')) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  await assert.rejects(
    () => verifyLiveDatabaseIdentity({ env: validMockEnv, queryRunner: mockMissingMarkerRunner }),
    (err) => err.message.includes('No identity marker row found')
  );
});

test('preflight succeeds with valid isolated metadata and returns non-secret report', async () => {
  const mockValidRunner = async (sql) => {
    if (sql.includes('current_database()')) {
      return { rows: [{ database_name: 'postgres', database_role: 'smarterp_test_runner' }] };
    }
    if (sql.includes('pg_roles')) {
      return { rows: [{ rolname: 'smarterp_test_runner', rolsuper: false, rolbypassrls: false }] };
    }
    if (sql.includes('smarterp_test_database_identity')) {
      return {
        rows: [{
          environment: 'isolated_test',
          project_ref: 'testprojectref123',
          database_name: 'postgres',
          database_role: 'smarterp_test_runner',
          isolation_token: 'token-abc1234567890-strictly-isolated',
        }],
      };
    }
    return { rows: [] };
  };

  const report = await verifyLiveDatabaseIdentity({ env: validMockEnv, queryRunner: mockValidRunner });
  assert.equal(report.status, 'PASS');
  assert.equal(report.isolated, true);
  assert.equal(report.environment, 'isolated_test');
  assert.equal(report.projectRef, 'testprojectref123');
  assert.equal(report.role, 'smarterp_test_runner');
  assert.equal(report.database, 'postgres');

  // Verify that secrets are not present in the returned safe report
  const reportStr = JSON.stringify(report);
  assert.doesNotMatch(reportStr, /secret_test_pw|token-abc/);
});

test('database-mutating integration and migration runners reject the default postgres database name', () => {
  assert.throws(() => assertDedicatedTestDatabaseName('postgres'), /default postgres database/);
  assert.throws(() => assertDedicatedTestDatabaseName('  POSTGRES  '), /default postgres database/);
  assert.throws(() => assertDedicatedTestDatabaseName(''), /name could not be verified/);
  assert.equal(assertDedicatedTestDatabaseName('smarterp_isolated_test'), true);
});
