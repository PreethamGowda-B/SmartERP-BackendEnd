'use strict';

const preflight = require('../../scripts/paymentTestDatabasePreflight');

function prepareDisposableDatabaseTest({ env: providedEnv, applyToProcess = true } = {}) {
  let env = providedEnv;
  if (!env) {
    try { env = preflight.loadTestEnvironment(); }
    catch { env = { ...process.env }; }
  }

  if (env.SMARTERP_DISPOSABLE_TEST_DB !== 'true') {
    return { enabled: false, reason: 'Skipped: set SMARTERP_DISPOSABLE_TEST_DB=true and provide an owner-approved isolated TEST_DATABASE_URL.' };
  }

  try {
    const safeConfig = preflight.assertTestConfiguration(env);
    if (applyToProcess) {
      process.env.NODE_ENV = 'test';
      process.env.SMARTERP_ENVIRONMENT = 'isolated_test';
      process.env.DATABASE_URL = env.TEST_DATABASE_URL;
    }
    return { enabled: true, env, safeConfig };
  } catch (error) {
    return { enabled: false, reason: `Skipped for safety: ${error.message}` };
  }
}

async function verifyDisposableDatabaseTest(pool, prepared) {
  if (!prepared?.enabled) throw new Error('Disposable database opt-in was not prepared.');
  return preflight.verifyLiveDatabaseIdentity({
    env: prepared.env,
    queryRunner: (sql, params) => pool.query(sql, params),
  });
}

function skipDisposableDatabaseTest(test, name, reason) {
  test(name, { skip: reason || 'Skipped: disposable database opt-in is required.' }, () => {});
}

module.exports = {
  prepareDisposableDatabaseTest,
  verifyDisposableDatabaseTest,
  skipDisposableDatabaseTest,
};
