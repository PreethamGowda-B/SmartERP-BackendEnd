'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getLocalMigrationFiles, inspectDatabaseMigrations } = require('../utils/migrationInspector');
const { printStartupDashboard, gatherInfrastructureStatus } = require('../utils/startupDashboard');
const { getCompanySettings, getCompanySetting, invalidateCompanySettings, _cache } = require('../services/companySettingsService');
const releaseInfo = require('../config/releaseInfo');
const logger = require('../utils/logger');

test('releaseInfo provides valid release metadata and verified code changes', () => {
  assert.equal(releaseInfo.productName, 'SmartERP Backend');
  assert.ok(typeof releaseInfo.version === 'string' && releaseInfo.version.length > 0);
  assert.ok(Array.isArray(releaseInfo.verifiedChanges));
  assert.ok(releaseInfo.verifiedChanges.length >= 5);
  const gitInfo = releaseInfo.getGitInfo();
  assert.ok(gitInfo.commitSha);
  assert.ok(gitInfo.branch);
});

test('migrationInspector scans local migration files and correctly sorts them', () => {
  const files = getLocalMigrationFiles();
  assert.ok(files.length >= 40);
  const m049 = files.find(f => f.id === '049');
  assert.ok(m049, 'Migration 049 must exist in local files');
  assert.equal(m049.name, '049_message_media_files_ownership_and_rls');
});

test('migrationInspector detects applied migrations and identifies 049 as pending when unrecorded', async () => {
  const mockPool = {
    connect: async () => ({
      query: async (sql, params) => {
        if (sql.includes("to_regclass('public.app_migration_history')")) {
          return { rows: [{ exists: true }] };
        }
        if (sql.includes('FROM app_migration_history')) {
          return {
            rows: [
              { migration_id: '048_ai_audit_telemetry_schema', applied_at: new Date('2026-11-16T12:00:00Z'), applied_by: 'postgres' },
              { migration_id: '047_session_inactivity_tracking', applied_at: new Date('2026-11-16T11:00:00Z'), applied_by: 'postgres' },
            ],
          };
        }
        if (sql.includes("to_regclass('public.schema_migrations')")) {
          return { rows: [{ exists: true }] };
        }
        if (sql.includes('FROM schema_migrations')) {
          return {
            rows: [
              { name: '001_hardening_indexes_and_migration.sql' },
              { name: '033_production_dispatch.sql' },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  };

  const status = await inspectDatabaseMigrations(mockPool);
  assert.equal(status.status, 'VERIFIED');
  assert.equal(status.schemaVersion, '048');
  assert.ok(status.latestApplied);
  assert.equal(status.latestApplied.id, '048');

  // Assert Migration 049 is reported as STAGED_PENDING_APPROVAL
  const pending049 = status.pendingMigrations.find(m => m.id === '049');
  assert.ok(pending049, 'Migration 049 must be in pendingMigrations list');
  assert.equal(pending049.status, 'STAGED_PENDING_APPROVAL');
});

test('migrationInspector handles absent database migration history gracefully', async () => {
  const emptyPool = {
    connect: async () => {
      throw new Error('connection refused to database');
    },
  };

  const status = await inspectDatabaseMigrations(emptyPool);
  assert.equal(status.status, 'QUERY_FAILED');
  assert.equal(status.schemaVersion, 'unverified');
  assert.ok(status.pendingMigrations.length > 0);
});

test('companySettingsService caches queries, isolates tenants, and invalidates on update', async () => {
  _cache.clear();

  let queryCount = 0;
  const mockPool = {
    query: async (sql, params) => {
      queryCount++;
      const companyId = params[0];
      return {
        rows: [
          { setting_key: 'hourly_rate', setting_value: companyId === 'company-A' ? '750' : '450' },
          { setting_key: 'auto_approve_customer_jobs', setting_value: 'true' },
        ],
      };
    },
  };

  // 1. Initial fetch for company-A
  const settingsA1 = await getCompanySettings('company-A', ['hourly_rate'], mockPool);
  assert.equal(settingsA1.hourly_rate, '750');
  assert.equal(queryCount, 1);

  // 2. Second fetch for company-A should hit in-memory cache (queryCount remains 1)
  const settingsA2 = await getCompanySettings('company-A', ['hourly_rate'], mockPool);
  assert.equal(settingsA2.hourly_rate, '750');
  assert.equal(queryCount, 1, 'Second fetch must be served from cache');

  // 3. Fetch for company-B must NOT use company-A cache (multi-tenant isolation)
  const settingsB = await getCompanySettings('company-B', ['hourly_rate'], mockPool);
  assert.equal(settingsB.hourly_rate, '450');
  assert.equal(queryCount, 2, 'Different company must query database');

  // 4. getCompanySetting single helper
  const rateA = await getCompanySetting('company-A', 'hourly_rate', '500', mockPool);
  assert.equal(rateA, '750');
  assert.equal(queryCount, 2, 'Cache hit must not increment query count');

  // 5. Invalidation
  invalidateCompanySettings('company-A');
  const settingsA3 = await getCompanySettings('company-A', ['hourly_rate'], mockPool);
  assert.equal(settingsA3.hourly_rate, '750');
  assert.equal(queryCount, 3, 'Post-invalidation fetch must re-query database');
});

test('startupDashboard generates a complete, clean, sanitized dashboard output', async () => {
  const mockPool = {
    options: { max: 4 },
    totalCount: 3,
    idleCount: 2,
    waitingCount: 0,
    connect: async () => ({
      query: async (sql) => {
        if (sql.includes('SELECT 1')) return { rows: [{ ready: 1 }] };
        if (sql.includes('to_regclass')) return { rows: [{ exists: false }] };
        return { rows: [] };
      },
      release: () => {},
    }),
    query: async () => ({ rows: [{ ready: 1 }] }),
  };

  const mockRedis = { status: 'ready' };

  const loggedLines = [];
  const originalLog = console.log;
  console.log = (line) => loggedLines.push(String(line));

  let report;
  try {
    report = await printStartupDashboard({
      port: 4000,
      processRole: 'primary-worker',
      workerId: 1,
      isPrimaryWorker: true,
      pool: mockPool,
      redisClient: mockRedis,
      backgroundWorkersStarted: true,
    });
  } finally {
    console.log = originalLog;
  }

  assert.ok(report.isReady);
  assert.equal(report.application.name, 'SmartERP Backend');
  const outputText = loggedLines.join('\n');

  // Verify dashboard sections are present
  assert.ok(outputText.includes('[APPLICATION]'));
  assert.ok(outputText.includes('[INFRASTRUCTURE]'));
  assert.ok(outputText.includes('[BACKGROUND SERVICES]'));
  assert.ok(outputText.includes('[DATABASE MIGRATIONS]'));
  assert.ok(outputText.includes('[RELEASE HIGHLIGHTS]'));
  assert.ok(outputText.includes('STATUS: APPLICATION READY'));

  // Verify no passwords, tokens, or raw secrets are present
  assert.equal(outputText.includes('password='), false);
  assert.equal(outputText.includes('postgres://'), false);
  assert.equal(outputText.includes('CLOUDINARY_API_SECRET'), false);
});

test('logger redaction cleans sensitive tokens and passwords from meta', () => {
  const sensitiveMeta = {
    password: 'superSecretPassword123',
    authToken: 'bearer-secret-token',
    customHeader: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotPrintThisSecretSignature',
    user: {
      id: 'usr_123',
      email: 'owner@test.com',
      cookie: 'session_id=abcdef',
    },
    normalField: 'ok_to_log',
  };

  const sanitized = logger.sanitize(sensitiveMeta);
  assert.equal(sanitized.password, '[REDACTED]');
  assert.equal(sanitized.authToken, '[REDACTED]');
  assert.equal(sanitized.customHeader, '[REDACTED_JWT]');
  assert.equal(sanitized.user.cookie, '[REDACTED]');
  assert.equal(sanitized.user.email, 'owner@test.com');
  assert.equal(sanitized.normalField, 'ok_to_log');
});

test('companySettingsService enforces 60-second TTL and handles remote cross-worker invalidation', async () => {
  const { SETTINGS_CACHE_TTL_MS } = require('../services/companySettingsService');
  assert.equal(SETTINGS_CACHE_TTL_MS, 60_000, 'TTL must be configured to exactly 60 seconds');

  _cache.clear();

  let queryCount = 0;
  const mockPool = {
    query: async () => {
      queryCount++;
      return {
        rows: [
          { setting_key: 'auto_approve_customer_jobs', setting_value: 'true' },
        ],
      };
    },
  };

  // 1. Initial fetch
  await getCompanySettings('company-ttl-test', ['auto_approve_customer_jobs'], mockPool);
  assert.equal(queryCount, 1);

  // 2. Fetch before TTL expires (cache hit)
  await getCompanySettings('company-ttl-test', ['auto_approve_customer_jobs'], mockPool);
  assert.equal(queryCount, 1, 'Should hit cache before TTL expiration');

  // 3. Artificially expire the cache entry to simulate 60s passing
  const cachedEntry = _cache.get('company-ttl-test');
  assert.ok(cachedEntry);
  cachedEntry.expiresAt = Date.now() - 1000; // Expired

  // 4. Fetch after TTL expiration should re-query DB
  await getCompanySettings('company-ttl-test', ['auto_approve_customer_jobs'], mockPool);
  assert.equal(queryCount, 2, 'Should query database after 60s TTL expires');

  // 5. Test remote cross-worker invalidation
  invalidateCompanySettings('company-ttl-test', true);
  assert.equal(_cache.has('company-ttl-test'), false, 'Remote invalidation must evict local cache');
});

test('startupDashboard fails closed when database is disconnected or degraded', async () => {
  const brokenPool = {
    options: { max: 4 },
    connect: async () => {
      throw new Error('Connection refused (db down)');
    },
    query: async () => {
      throw new Error('Connection refused (db down)');
    },
  };

  const loggedLines = [];
  const originalLog = console.log;
  console.log = (line) => loggedLines.push(String(line));

  let report;
  try {
    report = await printStartupDashboard({
      port: 4000,
      processRole: 'primary-worker',
      workerId: 1,
      isPrimaryWorker: true,
      pool: brokenPool,
      redisClient: null,
      backgroundWorkersStarted: false,
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(report.isReady, false, 'Dashboard must NOT report ready when database is disconnected');
  const outputText = loggedLines.join('\n');
  assert.ok(outputText.includes('STATUS: DEGRADED'), 'Dashboard must display DEGRADED status banner');
  assert.ok(outputText.includes('Keep-Alive Pinger: REMOVED'), 'Dashboard must show keep-alive pinger removed');
});

test('keepAlivePinger module is safely deprecated without side effects', () => {
  const pinger = require('../jobs/keepAlivePinger');
  assert.doesNotThrow(() => pinger.startKeepAlivePinger());
  assert.doesNotThrow(() => pinger.stopKeepAlivePinger());
});
