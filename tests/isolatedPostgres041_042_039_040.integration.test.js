'use strict';

// This file intentionally contains source-level migration safety checks only.
// Database integration tests must use the separately guarded runner after a
// complete isolated PostgreSQL schema is provisioned and verified.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FORWARD_MIGRATIONS,
  STARTUP_MIGRATIONS,
} = require('../migrations/forwardMigrationRunner');

const migrationsDir = path.join(__dirname, '..', 'migrations');
const ids = FORWARD_MIGRATIONS.map(({ id }) => id);
const startupIds = STARTUP_MIGRATIONS.map(({ id }) => id);

test('static migration safety: reviewed migrations have unique IDs and known source files', () => {
  assert.equal(new Set(ids).size, ids.length);
  for (const migration of FORWARD_MIGRATIONS) {
    assert.equal(fs.existsSync(path.join(migrationsDir, migration.file)), true, `${migration.id} source exists`);
  }
});

test('037, 038, 039, 041, and 042 are controlled migrations excluded from automatic startup', () => {
  for (const id of [
    '037_subscription_catalog_and_storage',
    '038_tiered_support_entitlements',
    '039_invoice_payment_idempotency',
    '041_superadmin_announcements_and_system_settings',
    '042_staff_password_reset_otp_scope',
  ]) {
    assert.equal(ids.includes(id), true, `${id} is known to the checksum-aware runner`);
    assert.equal(startupIds.includes(id), false, `${id} cannot run during application startup`);
  }
});

test('040 remains outside both migration registries pending historical invoice reconciliation', () => {
  const id = '040_direct_invoice_idempotency_fingerprint';
  assert.equal(ids.includes(id), false);
  assert.equal(startupIds.includes(id), false);
  assert.equal(fs.existsSync(path.join(migrationsDir, `${id}.sql`)), true);
});

test('payment integration runner performs the isolated-database preflight before opening its test connection', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'paymentIntegrationRunner.js'), 'utf8');
  const preflight = runner.indexOf('await runPreflight({ env: activeEnv })');
  const poolCreation = runner.indexOf('new Pool({', preflight);
  assert.ok(preflight >= 0);
  assert.ok(poolCreation > preflight);
  assert.match(runner, /connectionString:\s*activeEnv\.TEST_DATABASE_URL/);
  assert.match(runner, /assertDedicatedTestDatabaseName\(preflightReport\.database\)/);
  assert.match(runner, /applyForwardMigration\(client, \{ migrationId: migration\.id, sql: migrationSql \}\)/);
  assert.doesNotMatch(runner, /pool\.query\(migrationSql\)/);
  assert.doesNotMatch(runner, /987654321|987654322|00000000-0000-0000-0000-00000000000[12]/);
  assert.doesNotMatch(runner, /DELETE FROM invoice_payments WHERE company_id IN/);
  assert.match(runner, /DELETE FROM invoice_payments WHERE invoice_id = ANY\(\$1::uuid\[\]\) AND company_id = ANY\(\$2::int\[\]\)/);
});
