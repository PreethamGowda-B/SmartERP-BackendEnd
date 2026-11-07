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
  AI_AUDIT_TELEMETRY_SCHEMA,
  AI_AUDIT_TELEMETRY_COLUMNS,
  AI_AUDIT_LEGACY_COLUMNS,
  AI_AUDIT_REQUIRED_COLUMNS,
  AI_AUDIT_COLUMN_TYPE_OPTIONS,
  assertAiAuditTelemetrySchema,
  applyForwardMigration,
  assertRecognizedAiAuditBaseline,
  migrationChecksum,
} = require('../migrations/forwardMigrationRunner');

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', PRODUCTION_DISPATCH.file), 'utf8');
const aiAuditSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', AI_AUDIT_TELEMETRY_SCHEMA.file), 'utf8');

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
  assert.ok(allIds.includes(AI_AUDIT_TELEMETRY_SCHEMA.id));
  assert.ok(!allIds.includes('040_direct_invoice_idempotency_fingerprint'));

  const startupIds = STARTUP_MIGRATIONS.map(m => m.id);
  assert.ok(!startupIds.includes('041_superadmin_announcements_and_system_settings'));
  assert.ok(!startupIds.includes(SUPERADMIN_ANNOUNCEMENTS_SETTINGS.id));
  assert.ok(!startupIds.includes(STAFF_PASSWORD_RESET_OTP_SCOPE.id));
  assert.ok(!startupIds.includes(AI_RAG_PERSISTENT_CONVERSATIONS.id));
  assert.ok(!startupIds.includes(AI_AUDIT_TELEMETRY_SCHEMA.id));
  assert.ok(!startupIds.includes('037_subscription_catalog_and_storage'));
  assert.ok(!startupIds.includes(INVOICE_PAYMENT_IDEMPOTENCY.id));
});

test('AI audit migration reconciles runtime-only baselines with legacy columns and shared schema checks', async () => {
  assert.ok(aiAuditSql.includes('ADD COLUMN IF NOT EXISTS user_name TEXT'));
  assert.ok(aiAuditSql.includes('ADD COLUMN IF NOT EXISTS details JSONB'));
  assert.doesNotMatch(aiAuditSql, /LEFT\(prompt,\s*200\)/i, 'migration must not copy legacy prompt text into telemetry');
  assert.doesNotMatch(aiAuditSql, /action_params\s*=\s*COALESCE\(action_params,\s*details/i, 'migration must not duplicate unreviewed legacy details');
  assert.equal(AI_AUDIT_REQUIRED_COLUMNS.length, new Set([...AI_AUDIT_TELEMETRY_COLUMNS, ...AI_AUDIT_LEGACY_COLUMNS]).size);
  const runtimeColumns = ['id','company_id','user_id','user_role','tool_name','action_params','status','error_message','created_at','portal','module','plan_tier','model_scope','latency_ms','confidence_score','blocked','prompt_preview'];
  const baseline = await assertRecognizedAiAuditBaseline({ query: async () => ({ rows: runtimeColumns.map((column_name) => ({ column_name })) }) });
  assert.equal(baseline.baseline, 'legacy_runtime_ddl');
  const legacyColumns = ['id','company_id','user_id','user_name','role','prompt','action_name','affected_record_id','status','details','created_at'];
  assert.equal((await assertRecognizedAiAuditBaseline({ query: async () => ({ rows: legacyColumns.map((column_name) => ({ column_name })) }) })).baseline, '018_legacy');
  assert.deepEqual(await assertRecognizedAiAuditBaseline({ query: async () => ({ rows: [] }) }), { tableExists: false, baseline: null });
  await assert.rejects(assertRecognizedAiAuditBaseline({ query: async () => ({ rows: [{ column_name: 'id' }, { column_name: 'user_id' }] }) }), /unrecognized existing/);

  const validColumns = Object.entries(AI_AUDIT_COLUMN_TYPE_OPTIONS).map(([column_name, types]) => ({
    column_name,
    data_type: types[0],
    is_nullable: ['role', 'prompt', 'action_name'].includes(column_name) ? 'YES' : 'NO',
  }));
  const validIndexes = [
    { indexname: 'idx_ai_audit_logs_created_at', indexdef: 'CREATE INDEX idx_ai_audit_logs_created_at ON public.ai_audit_logs USING btree (created_at DESC)' },
    { indexname: 'idx_ai_audit_logs_company_created', indexdef: 'CREATE INDEX idx_ai_audit_logs_company_created ON public.ai_audit_logs USING btree (company_id, created_at DESC)' },
  ];
  const schemaCheck = await assertAiAuditTelemetrySchema({ query: async (queryText) => {
    if (String(queryText).includes('to_regclass')) return { rows: [{ table_exists: true }] };
    if (String(queryText).includes('information_schema.columns')) return { rows: validColumns };
    if (String(queryText).includes('pg_indexes')) return { rows: validIndexes };
    throw new Error('unexpected schema query');
  } });
  assert.equal(schemaCheck.table_exists, true);
  await assert.rejects(assertAiAuditTelemetrySchema({ query: async (queryText) => {
    if (String(queryText).includes('to_regclass')) return { rows: [{ table_exists: true }] };
    if (String(queryText).includes('information_schema.columns')) return { rows: [{ column_name: 'company_id', data_type: 'integer', is_nullable: 'YES' }] };
    return { rows: [] };
  } }), /schema verification failed/);
});

test('Migration 048 is registered as controlled and does not run on application startup', () => {
  const migration = FORWARD_MIGRATIONS.find(item => item.id === AI_AUDIT_TELEMETRY_SCHEMA.id);
  assert.equal(migration.file, '048_ai_audit_telemetry_schema.sql');
  assert.ok(!STARTUP_MIGRATIONS.some(item => item.id === AI_AUDIT_TELEMETRY_SCHEMA.id));
  const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', migration.file), 'utf8');
  assert.match(migrationSql, /UPDATE public\.ai_audit_logs/);
  assert.match(migrationSql, /ALTER TABLE public\.ai_audit_logs ALTER COLUMN company_id TYPE TEXT/);
  assert.doesNotMatch(migrationSql, /\b(?:DROP TABLE|TRUNCATE)\b/i);
});

test('Migration 048 recognizes only the documented legacy/runtime audit layouts', async () => {
  const legacy = ['id','company_id','user_id','user_name','role','prompt','action_name','affected_record_id','status','details','created_at'];
  const accepted = await assertRecognizedAiAuditBaseline({
    async query() { return { rows: legacy.map(column_name => ({ column_name })) }; },
  });
  assert.deepEqual(accepted, { tableExists: true, baseline: '018_legacy' });
  await assert.rejects(assertRecognizedAiAuditBaseline({
    async query() { return { rows: [{ column_name: 'id' }, { column_name: 'company_id' }] }; },
  }), /unrecognized existing ai_audit_logs schema/);
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
