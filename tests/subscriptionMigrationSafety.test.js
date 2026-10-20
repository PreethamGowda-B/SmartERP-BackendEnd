'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FORWARD_MIGRATIONS, STARTUP_MIGRATIONS } = require('../migrations/forwardMigrationRunner');
const {
  assertIsolatedTarget,
  assertTargetConfiguration,
  assertLegacyPlanMapping,
  assertCanonicalPlans,
  assertNoStorageBackfillGaps,
} = require('../scripts/subscriptionMigrationChecks');
const { SUBSCRIPTION_PLANS } = require('../services/subscriptionCatalog');

const baseEnv = {
  NODE_ENV: 'test',
  SMARTERP_ENVIRONMENT: 'isolated_test',
  DATABASE_URL: 'postgres://app:secret@prod-db.example:5432/smarterp',
  SMARTERP_SUBSCRIPTION_TEST_DATABASE_URL: 'postgres://migration:secret@test-db.example:5432/smarterp_test',
  SMARTERP_SUBSCRIPTION_TEST_DATABASE: 'smarterp_test',
  SMARTERP_SUBSCRIPTION_TEST_DATABASE_HOST: 'test-db.example',
  SMARTERP_SUBSCRIPTION_TEST_DATABASE_PORT: '5432',
  SMARTERP_SUBSCRIPTION_TEST_DATABASE_ROLE: 'migration',
  SMARTERP_SUBSCRIPTION_TEST_DATABASE_OID: '16384',
  SMARTERP_SUBSCRIPTION_TEST_ISOLATION_ID: 'db-approval-2026-10',
};
const baseIdentity = {
  database_name: 'smarterp_test', database_role: 'migration',
  host: 'test-db.example', port: '5432', database_oid: '16384',
};
const baseRole = { rolsuper: false, rolbypassrls: false };
const baseMarker = {
  environment: 'isolated_test', isolation_id: 'db-approval-2026-10',
  database_name: 'smarterp_test', database_role: 'migration', database_oid: '16384',
};

test('migration 037 remains explicitly registered but is excluded from startup and numbered sweeps', () => {
  assert.ok(FORWARD_MIGRATIONS.some(item => item.id === '037_subscription_catalog_and_storage'));
  assert.ok(!STARTUP_MIGRATIONS.some(item => item.id === '037_subscription_catalog_and_storage'));
  const autoMigrate = fs.readFileSync(path.join(__dirname, '../migrations/autoMigrate.js'), 'utf8');
  assert.match(autoMigrate, /'037_subscription_catalog_and_storage\.sql'/);
  assert.match(autoMigrate, /filename === '037_subscription_catalog_and_storage\.sql'/);
});

test('explicit migration script validates configured target before creating its connection pool', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/runSubscriptionMigration.js'), 'utf8');
  assert.ok(script.indexOf('assertTargetConfiguration(process.env)') < script.indexOf('new Pool('));
  assert.match(script, /assertIsolatedTarget\(\{ env: process\.env, identity, role: roleResult\.rows\[0\], marker \}\)/);
  assert.match(script, /assertLegacyPlanMapping\(legacyPlans\.rows\)/);
  assert.match(script, /assertCanonicalPlans\(plans\.rows\)/);
  assert.match(script, /set_config\('app\.bypass_rls', 'true', false\)/);
});

test('migration 037 rejects the default postgres database before opening the connection', () => {
  assert.throws(() => assertTargetConfiguration({
    ...baseEnv,
    SMARTERP_SUBSCRIPTION_TEST_DATABASE: 'postgres',
    SMARTERP_SUBSCRIPTION_TEST_DATABASE_URL: 'postgres://migration:secret@test-db.example:5432/postgres',
  }), /default postgres database/);
  assert.throws(() => assertTargetConfiguration({
    ...baseEnv,
    SMARTERP_SUBSCRIPTION_TEST_DATABASE_ROLE: 'postgres',
    SMARTERP_SUBSCRIPTION_TEST_DATABASE_URL: 'postgres://postgres:secret@test-db.example:5432/smarterp_test',
  }), /default postgres database/);
});

test('migration preflight rejects the application database even when the test role differs', () => {
  assert.throws(() => assertTargetConfiguration({
    ...baseEnv,
    DATABASE_URL: 'postgres://app:secret@test-db.example:5432/smarterp_test',
  }), /resolves to the configured application database/);
});

test('migration preflight rejects absent marker, identity mismatch, and privileged role', () => {
  assert.doesNotThrow(() => assertIsolatedTarget({ env: baseEnv, identity: baseIdentity, role: baseRole, marker: baseMarker }));
  assert.throws(() => assertIsolatedTarget({ env: baseEnv, identity: baseIdentity, role: baseRole, marker: null }), /identity marker/);
  assert.throws(() => assertIsolatedTarget({ env: baseEnv, identity: { ...baseIdentity, database_name: 'postgres' }, role: baseRole, marker: baseMarker }), /identity does not match/);
  assert.throws(() => assertIsolatedTarget({ env: baseEnv, identity: { ...baseIdentity, database_oid: '99999' }, role: baseRole, marker: baseMarker }), /identity does not match/);
  assert.throws(() => assertIsolatedTarget({ env: baseEnv, identity: baseIdentity, role: { ...baseRole, rolsuper: true }, marker: baseMarker }), /privileged migration role/);
  assert.throws(() => assertIsolatedTarget({ env: baseEnv, identity: baseIdentity, role: baseRole, marker: { ...baseMarker, isolation_id: 'wrong' } }), /identity marker/);
});

test('plan preflight accepts only stable legacy or canonical ID mappings', () => {
  assert.doesNotThrow(() => assertLegacyPlanMapping([
    { id: 1, name: 'Free' }, { id: 2, name: 'Basic' }, { id: 3, name: 'Pro' },
  ]));
  assert.doesNotThrow(() => assertLegacyPlanMapping([
    { id: 1, name: 'Starter' }, { id: 2, name: 'Professional' }, { id: 3, name: 'Enterprise' },
  ]));
  assert.throws(() => assertLegacyPlanMapping([
    { id: 1, name: 'Free' }, { id: 2, name: 'Enterprise' }, { id: 3, name: 'Pro' },
  ]), /plan 2/);
  assert.throws(() => assertLegacyPlanMapping([
    { id: 1, name: 'Free' }, { id: 2, name: 'Basic' }, { id: 3, name: 'Pro' }, { id: 4, name: 'Starter' },
  ]), /unexpected ID/);
});

test('migration derives company foreign-key column type from companies.id', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/037_subscription_catalog_and_storage.sql'), 'utf8');
  assert.match(sql, /format_type\(a\.atttypid, a\.atttypmod\)/);
  assert.match(sql, /company_id_type NOT IN \('integer', 'bigint', 'uuid'\)/);
  assert.equal((sql.match(/company_id %s NOT NULL REFERENCES public\.companies\(id\)/g) || []).length, 2);
  assert.match(sql, /ON DELETE RESTRICT/);
});

test('canonical migration verification checks every catalog price, quota, and feature flag', () => {
  const rows = Object.entries(SUBSCRIPTION_PLANS).map(([id, plan]) => ({
    id: Number(id), name: plan.name, price_monthly: plan.priceMonthly,
    price_yearly: plan.priceYearly, employee_limit: plan.employeeLimit,
    max_active_jobs: plan.activeJobsLimit, max_inventory_items: plan.inventoryItemsLimit,
    max_storage_bytes: plan.storageBytesLimit, max_material_requests: null,
    messages_history_days: 30, features: { ...plan.features },
  }));
  assert.doesNotThrow(() => assertCanonicalPlans(rows));
  assert.throws(() => assertCanonicalPlans(rows.map(row => row.id === 1 ? { ...row, max_storage_bytes: 123 } : row)), /max_storage_bytes/);
  assert.throws(() => assertCanonicalPlans(rows.map(row => row.id === 2 ? { ...row, features: { ...row.features, payroll: false } } : row)), /feature flags/);
});

test('migration SQL retains transaction-safe and tenant-scoped protections', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/037_subscription_catalog_and_storage.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS company_storage_usage/);
  assert.match(sql, /ON CONFLICT \(company_id, storage_key\) DO NOTHING/);
  assert.equal((sql.match(/ENABLE ROW LEVEL SECURITY/g) || []).length, 3);
  assert.equal((sql.match(/FORCE ROW LEVEL SECURITY/g) || []).length, 3);
  assert.match(sql, /current_setting\('app\.current_company_id', TRUE\)/);
  assert.match(sql, /ON CONFLICT \(id\) DO UPDATE SET/);
  assert.match(sql, /COALESCE\(image_size_bytes, 0\) <= 0/);
  assert.match(sql, /COALESCE\(file_size_bytes, 0\) <= 0/);
});

test('storage backfill verification rejects missing legacy file accounting', () => {
  assert.doesNotThrow(() => assertNoStorageBackfillGaps({ inventory_images_missing: 0, employee_documents_missing: '0' }));
  assert.throws(() => assertNoStorageBackfillGaps({ inventory_images_missing: 2 }), /2 unaccounted file/);
  const verifier = fs.readFileSync(path.join(__dirname, '../scripts/subscriptionMigrationChecks.js'), 'utf8');
  for (const source of ['inventory_items', 'employee_documents', 'material_purchase_bills', 'message_attachments', 'job_messages', 'job_proof_of_work']) {
    assert.ok(verifier.includes(source), `backfill verifier should check ${source}`);
  }
});

test('Cloudinary configuration has no source credential fallback and example values are placeholders', () => {
  const source = fs.readFileSync(path.join(__dirname, '../config/cloudinary.js'), 'utf8');
  const example = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf8');
  assert.match(source, /process\.env\.CLOUDINARY_API_KEY\s*\|\|\s*''/);
  assert.match(source, /process\.env\.CLOUDINARY_API_SECRET\s*\|\|\s*''/);
  assert.doesNotMatch(source, /api_secret\s*:\s*['"][^'"]{8,}/i);
  assert.match(example, /^CLOUDINARY_API_KEY=your_api_key$/m);
  assert.match(example, /^CLOUDINARY_API_SECRET=your_api_secret$/m);
});
