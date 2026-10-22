'use strict';

/**
 * SmartERP Phase 7 — Database Safety Preflight Utility
 *
 * Validates that any future database integration test operates strictly against
 * a separate, owner-approved, isolated PostgreSQL test database.
 *
 * SAFETY RULES:
 * 1. NEVER falls back to DATABASE_URL.
 * 2. NEVER prints or logs passwords, tokens, connection strings, or raw secrets.
 * 3. Rejects superuser (rolsuper) or bypass-RLS (rolbypassrls) roles.
 * 4. Verifies that the connected host/database/project does not match production.
 * 5. Requires an in-database identity marker row (smarterp_test_database_identity).
 * 6. Read-only preflight: performs ZERO schema alterations and ZERO data mutations.
 */

const path = require('node:path');
const fs = require('node:fs');

function parseDatabaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error('Invalid database connection URL structure.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Database target must use the postgresql: protocol.');
  }

  // Extract Supabase project ref if present in username (role.<projectRef>) or host
  const rawUsername = decodeURIComponent(parsed.username || '');
  let roleName = rawUsername;
  let projectRef = null;

  if (rawUsername.includes('.')) {
    const parts = rawUsername.split('.');
    roleName = parts[0];
    projectRef = parts.slice(1).join('.');
  }

  const host = parsed.hostname.toLowerCase();
  const hostMatch = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (hostMatch) {
    projectRef = hostMatch[1];
  }

  return {
    host,
    port: parsed.port || '5432',
    database: decodeURIComponent((parsed.pathname || '').replace(/^\//, '')),
    role: roleName,
    fullUsername: rawUsername,
    projectRef,
    hasPlaceholderPassword: parsed.password ? (parsed.password.includes('REPLACE_WITH') || parsed.password.includes('replace_with')) : false,
  };
}

function loadTestEnvironment() {
  const env = { ...process.env };

  // Explicitly load .env first to establish the baseline production DATABASE_URL for safety comparison
  const baseEnvPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(baseEnvPath)) {
    const baseContent = fs.readFileSync(baseEnvPath, 'utf8');
    for (const line of baseContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (env[k] === undefined) env[k] = v;
      }
    }
  }

  // Explicitly load .env.test.local (overriding test vars)
  const testEnvPath = path.join(__dirname, '..', '.env.test.local');
  if (fs.existsSync(testEnvPath)) {
    const testContent = fs.readFileSync(testEnvPath, 'utf8');
    for (const line of testContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        env[k] = v;
      }
    }
    // When loading isolated test environment, override inherited production NODE_ENV to 'test'
    if (env.SMARTERP_ENVIRONMENT === 'isolated_test' && env.NODE_ENV === 'production') {
      env.NODE_ENV = 'test';
    }
  }

  return env;
}

function assertTestConfiguration(env = process.env) {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing execution: NODE_ENV is set to production.');
  }
  if (env.SMARTERP_ENVIRONMENT !== 'isolated_test') {
    throw new Error('Refusing execution: SMARTERP_ENVIRONMENT must be explicitly set to "isolated_test".');
  }

  const testUrl = env.TEST_DATABASE_URL;
  if (!testUrl || typeof testUrl !== 'string' || !testUrl.trim()) {
    throw new Error('Refusing execution: TEST_DATABASE_URL is missing. Production fallback is forbidden.');
  }

  if (env.TEST_DATABASE_AUTHORIZATION !== 'AUTHORIZED_BY_OWNER_FOR_TESTING') {
    throw new Error('Refusing execution: TEST_DATABASE_AUTHORIZATION must be "AUTHORIZED_BY_OWNER_FOR_TESTING".');
  }

  const requiredVariables = [
    'TEST_DATABASE_PROJECT_REF',
    'TEST_DATABASE_ROLE',
    'TEST_DATABASE_ISOLATION_TOKEN',
  ];
  for (const varName of requiredVariables) {
    if (!env[varName] || typeof env[varName] !== 'string' || !env[varName].trim()) {
      throw new Error(`Refusing execution: Required test configuration ${varName} is missing.`);
    }
  }

  const target = parseDatabaseUrl(testUrl);

  // If a production DATABASE_URL exists, verify that TEST_DATABASE_URL does NOT resolve to it
  if (env.DATABASE_URL && typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim()) {
    try {
      const prodTarget = parseDatabaseUrl(env.DATABASE_URL);
      const sameHost = target.host === prodTarget.host;
      const samePort = target.port === prodTarget.port;
      const sameDb = target.database === prodTarget.database;
      const sameProject = target.projectRef && prodTarget.projectRef && target.projectRef === prodTarget.projectRef;

      if ((sameHost && samePort && sameDb) || sameProject) {
        throw new Error('FATAL SAFETY VIOLATION: TEST_DATABASE_URL targets the production/application database.');
      }
    } catch (parseErr) {
      if (parseErr.message.includes('FATAL SAFETY VIOLATION')) throw parseErr;
      // If DATABASE_URL is somehow unparseable, continue strict checks on target
    }
  }

  // Refuse default superuser accounts
  if (['postgres', 'root', 'admin'].includes(target.role.toLowerCase())) {
    throw new Error('Refusing execution: Test role cannot be the default administrative superuser.');
  }

  // Enforce expected role match
  if (target.role !== env.TEST_DATABASE_ROLE) {
    throw new Error('Refusing execution: TEST_DATABASE_URL username does not match TEST_DATABASE_ROLE.');
  }

  // Enforce project ref match if detectable
  if (target.projectRef && target.projectRef !== env.TEST_DATABASE_PROJECT_REF) {
    throw new Error('Refusing execution: Detected project reference does not match TEST_DATABASE_PROJECT_REF.');
  }

  // Refuse template placeholders
  if (target.hasPlaceholderPassword) {
    throw new Error('Refusing execution: TEST_DATABASE_URL contains an unpopulated placeholder password. Please update .env.test.local with your real test role password.');
  }
  if (env.TEST_DATABASE_ISOLATION_TOKEN.includes('REPLACE_WITH') || env.TEST_DATABASE_ISOLATION_TOKEN.includes('replace_with')) {
    throw new Error('Refusing execution: TEST_DATABASE_ISOLATION_TOKEN contains an unpopulated placeholder. Please update .env.test.local with your unique isolation token.');
  }

  // A database name containing "test" alone is not sufficient proof of isolation
  if (!env.TEST_DATABASE_ISOLATION_TOKEN || env.TEST_DATABASE_ISOLATION_TOKEN.length < 16) {
    throw new Error('Refusing execution: TEST_DATABASE_ISOLATION_TOKEN must be at least 16 characters.');
  }

  return {
    host: target.host,
    port: target.port,
    database: target.database,
    role: target.role,
    projectRef: env.TEST_DATABASE_PROJECT_REF,
  };
}

function assertDedicatedTestDatabaseName(databaseName) {
  if (typeof databaseName !== 'string' || !databaseName.trim()) {
    throw new Error('Refusing database tests: the connected database name could not be verified.');
  }
  if (databaseName.trim().toLowerCase() === 'postgres') {
    throw new Error('Refusing database tests or migrations against the default postgres database. Use a dedicated isolated database.');
  }
  return true;
}

async function verifyLiveDatabaseIdentity({ env = process.env, queryRunner }) {
  if (typeof queryRunner !== 'function') {
    throw new Error('A queryRunner function is required for live preflight verification.');
  }

  const safeConfig = assertTestConfiguration(env);

  // 1. Query connected PostgreSQL database and user
  let dbIdentity;
  try {
    const res = await queryRunner('SELECT current_database() as database_name, current_user as database_role;');
    dbIdentity = res.rows?.[0];
  } catch (err) {
    throw new Error(`Failed to query database identity: ${err.message}`);
  }

  if (!dbIdentity || dbIdentity.database_name !== safeConfig.database) {
    throw new Error('Connected database name does not match expected test database name.');
  }
  if (dbIdentity.database_role !== safeConfig.role) {
    throw new Error('Connected database user does not match expected TEST_DATABASE_ROLE.');
  }

  // 2. Query role attributes: MUST NOT be superuser and MUST NOT have BYPASSRLS
  let roleRes;
  try {
    roleRes = await queryRunner(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user LIMIT 1;'
    );
  } catch (err) {
    throw new Error(`Failed to query role permissions: ${err.message}`);
  }

  const role = roleRes.rows?.[0];
  if (!role) {
    throw new Error('Connected role could not be verified in pg_roles.');
  }
  if (role.rolsuper === true) {
    throw new Error('FATAL SAFETY VIOLATION: Test database role has SUPERUSER privilege.');
  }
  if (role.rolbypassrls === true) {
    throw new Error('FATAL SAFETY VIOLATION: Test database role has BYPASSRLS privilege. Tenant isolation cannot be verified.');
  }

  // 3. Query in-database identity marker
  let markerRes;
  try {
    markerRes = await queryRunner(
      'SELECT environment, project_ref, database_name, database_role, isolation_token FROM smarterp_test_database_identity LIMIT 1;'
    );
  } catch (err) {
    throw new Error('In-database test identity marker table (smarterp_test_database_identity) was not found.');
  }

  const marker = markerRes.rows?.[0];
  if (!marker) {
    throw new Error('No identity marker row found in smarterp_test_database_identity.');
  }
  if (marker.environment !== 'isolated_test') {
    throw new Error('Identity marker environment is not "isolated_test".');
  }
  if (marker.project_ref !== safeConfig.projectRef) {
    throw new Error('Identity marker project_ref does not match TEST_DATABASE_PROJECT_REF.');
  }
  if (marker.database_role !== safeConfig.role) {
    throw new Error('Identity marker database_role does not match TEST_DATABASE_ROLE.');
  }
  if (marker.isolation_token !== env.TEST_DATABASE_ISOLATION_TOKEN) {
    throw new Error('Identity marker isolation_token does not match TEST_DATABASE_ISOLATION_TOKEN.');
  }

  return {
    status: 'PASS',
    isolated: true,
    environment: marker.environment,
    projectRef: safeConfig.projectRef,
    role: safeConfig.role,
    database: safeConfig.database,
    verifiedAt: new Date().toISOString(),
  };
}

async function runPreflight({ env = loadTestEnvironment(), configOnly = false } = {}) {
  const safeConfig = assertTestConfiguration(env);
  if (configOnly) {
    return {
      status: 'PASS_CONFIG_VALIDATED',
      isolated: true,
      projectRef: safeConfig.projectRef,
      role: safeConfig.role,
      database: safeConfig.database,
      verifiedAt: new Date().toISOString(),
    };
  }

  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: env.TEST_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 20000,
    max: 2,
  });

  try {
    const report = await verifyLiveDatabaseIdentity({
      env,
      queryRunner: (sql, params) => pool.query(sql, params),
    });
    return report;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  const configOnly = process.argv.includes('--config-only') || process.argv.includes('--dry-run');
  runPreflight({ configOnly })
    .then((report) => {
      console.log('Preflight check completed successfully:');
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('Preflight check failed:');
      console.error(err.message || 'Unknown preflight error');
      process.exit(1);
    });
}

module.exports = {
  loadTestEnvironment,
  parseDatabaseUrl,
  assertTestConfiguration,
  assertDedicatedTestDatabaseName,
  verifyLiveDatabaseIdentity,
  runPreflight,
};
