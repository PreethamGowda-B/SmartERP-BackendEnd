'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  FORWARD_MIGRATIONS,
  STARTUP_MIGRATIONS,
  PRODUCTION_DISPATCH,
  INVOICE_PAYMENT_IDEMPOTENCY,
  SUPERADMIN_ANNOUNCEMENTS_SETTINGS,
  STAFF_PASSWORD_RESET_OTP_SCOPE,
  AI_RAG_PERSISTENT_CONVERSATIONS,
  applyForwardMigration,
  migrationChecksum,
} = require('../migrations/forwardMigrationRunner');

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', PRODUCTION_DISPATCH.file), 'utf8');

function createMockClient({
  existingChecksum = null,
  legacyLedger = false,
  legacyApplied = false,
  failOnQuery = null,
  tableCount = 10,
} = {}) {
  const calls = [];
  return {
    calls,
    async query(queryText, params = []) {
      calls.push({ queryText, params });
      if (failOnQuery && queryText.includes(failOnQuery)) {
        throw new Error(`simulated failure on ${failOnQuery}`);
      }
      if (queryText.includes('SELECT checksum_sha256 FROM app_migration_history')) {
        return { rows: existingChecksum ? [{ checksum_sha256: existingChecksum }] : [] };
      }
      if (queryText.includes("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists")) {
        return { rows: [{ exists: legacyLedger }] };
      }
      if (queryText.includes('SELECT name FROM schema_migrations WHERE name = $1')) {
        return { rows: legacyApplied ? [{ name: params[0] }] : [] };
      }
      if (queryText.includes('SELECT c.relname AS name')) {
        return { rows: [] };
      }
      if (queryText.includes("to_regprocedure('public.production_reject_history_mutation()') IS NOT NULL AS exists")) {
        return { rows: [{ exists: false }] };
      }
      if (queryText.includes('SELECT\n      (SELECT COUNT(*)::int FROM pg_class')) {
        return {
          rows: [{
            table_count: tableCount,
            rls_count: 10,
            policy_count: 10,
            index_count: 11,
            trigger_count: 5,
            constraint_count: 57,
            foreign_key_count: 22,
            history_function: true,
            app_role_safe: true,
            app_schema_usage: true,
            app_grant_count: 10,
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

test('Regression: controlled subscription, support, and migrations 041-044 stay out of automatic startup', () => {
  const allIds = FORWARD_MIGRATIONS.map(m => m.id);
  assert.ok(allIds.includes('033_production_dispatch'));
  assert.ok(allIds.includes('038_tiered_support_entitlements'));
  assert.ok(allIds.includes(INVOICE_PAYMENT_IDEMPOTENCY.id));
  assert.ok(allIds.includes('041_superadmin_announcements_and_system_settings'));
  assert.ok(allIds.includes(STAFF_PASSWORD_RESET_OTP_SCOPE.id));
  assert.ok(allIds.includes(AI_RAG_PERSISTENT_CONVERSATIONS.id));
  assert.ok(!allIds.includes('040_direct_invoice_idempotency_fingerprint'));

  const startupIds = STARTUP_MIGRATIONS.map(m => m.id);
  assert.ok(!startupIds.includes('041_superadmin_announcements_and_system_settings'));
  assert.ok(!startupIds.includes(SUPERADMIN_ANNOUNCEMENTS_SETTINGS.id));
  assert.ok(!startupIds.includes(STAFF_PASSWORD_RESET_OTP_SCOPE.id));
  assert.ok(!startupIds.includes(AI_RAG_PERSISTENT_CONVERSATIONS.id));
  assert.ok(!startupIds.includes('037_subscription_catalog_and_storage'));
  assert.ok(!startupIds.includes(INVOICE_PAYMENT_IDEMPOTENCY.id));
});

test('Migration 039 adopts complete untracked schema without replaying its DDL', async () => {
  const calls = [];
  const checkDefinition = `CHECK ((idempotency_key IS NULL AND request_fingerprint IS NULL AND result_status IS NULL AND result_amount_paid IS NULL AND result_amount_due IS NULL) OR (idempotency_key IS NOT NULL AND length(idempotency_key) BETWEEN 8 AND 128 AND request_fingerprint IS NOT NULL AND length(request_fingerprint) = 64 AND result_status IS NOT NULL AND result_amount_paid IS NOT NULL AND result_amount_due IS NOT NULL))`;
  const client = {
    async query(queryText) {
      calls.push(queryText);
      if (queryText.includes('SELECT checksum_sha256 FROM app_migration_history')) return { rows: [] };
      if (queryText.includes("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists")) return { rows: [{ exists: false }] };
      if (queryText.includes("to_regclass('public.invoice_payments') IS NOT NULL AS payment_table_exists")) {
        return { rows: [{ payment_table_exists: true, nullable_columns: 5, company_unique_partial_index: true, result_check_definition: checkDefinition }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', INVOICE_PAYMENT_IDEMPOTENCY.file), 'utf8');
  const result = await applyForwardMigration(client, { migrationId: INVOICE_PAYMENT_IDEMPOTENCY.id, sql: migrationSql });
  assert.equal(result.status, 'adopted_verified_schema');
  assert.equal(calls.some((queryText) => queryText.includes('ALTER TABLE invoice_payments')), false);
  assert.equal(calls.some((queryText) => queryText.includes('INSERT INTO app_migration_history')), true);
  assert.equal(calls.at(-1), 'COMMIT');
});

test('Migration 039 refuses partial untracked schema without replaying additive DDL', async () => {
  const calls = [];
  const client = {
    async query(queryText) {
      calls.push(queryText);
      if (queryText.includes('SELECT checksum_sha256 FROM app_migration_history')) return { rows: [] };
      if (queryText.includes("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists")) return { rows: [{ exists: false }] };
      if (queryText.includes("to_regclass('public.invoice_payments') IS NOT NULL AS payment_table_exists")) {
        return { rows: [{ payment_table_exists: true, nullable_columns: 1, company_unique_partial_index: false, result_check_definition: null }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', INVOICE_PAYMENT_IDEMPOTENCY.file), 'utf8');
  await assert.rejects(
    applyForwardMigration(client, { migrationId: INVOICE_PAYMENT_IDEMPOTENCY.id, sql: migrationSql }),
    /Invoice payment idempotency schema verification failed/
  );
  assert.equal(calls.some((queryText) => queryText.includes('ALTER TABLE invoice_payments')), false);
  assert.equal(calls.some((queryText) => queryText.includes('INSERT INTO app_migration_history')), false);
  assert.equal(calls.at(-1), 'ROLLBACK');
});

test('Regression: partial failure inside migration execution triggers ROLLBACK and omits ledger record', async () => {
  const client = createMockClient({ failOnQuery: 'CREATE TABLE IF NOT EXISTS production_sequences' });
  await assert.rejects(
    applyForwardMigration(client, { migrationId: PRODUCTION_DISPATCH.id, sql }),
    /simulated failure on CREATE TABLE IF NOT EXISTS production_sequences/
  );
  assert.equal(client.calls.some(c => c.queryText.includes('INSERT INTO app_migration_history')), false);
  assert.equal(client.calls.at(-1).queryText, 'ROLLBACK');
});

test('Regression: replay with identical checksum returns already_applied without re-executing DDL', async () => {
  const currentChecksum = migrationChecksum(sql);
  const client = createMockClient({ existingChecksum: currentChecksum });
  const result = await applyForwardMigration(client, { migrationId: PRODUCTION_DISPATCH.id, sql });
  assert.equal(result.status, 'already_applied');
  assert.equal(client.calls.some(c => c.queryText.includes('CREATE TABLE IF NOT EXISTS production_sequences')), false);
  assert.equal(client.calls.at(-1).queryText, 'COMMIT');
});

test('Regression: replay with altered checksum throws mismatch error and rolls back', async () => {
  const client = createMockClient({ existingChecksum: '0'.repeat(64) });
  await assert.rejects(
    applyForwardMigration(client, { migrationId: PRODUCTION_DISPATCH.id, sql }),
    /Checksum mismatch for already-recorded migration/
  );
  assert.equal(client.calls.at(-1).queryText, 'ROLLBACK');
});

test('Regression: history adoption rolls back and throws if postconditions are not satisfied', async () => {
  const client = createMockClient({ legacyLedger: true, legacyApplied: true, tableCount: 4 });
  await assert.rejects(
    applyForwardMigration(client, { migrationId: PRODUCTION_DISPATCH.id, sql }),
    /table_count: expected 10, got 4/
  );
  assert.equal(client.calls.some(c => c.queryText.includes('INSERT INTO app_migration_history')), false);
  assert.equal(client.calls.at(-1).queryText, 'ROLLBACK');
});
