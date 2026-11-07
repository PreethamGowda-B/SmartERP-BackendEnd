'use strict';

// Read-only production/staging preflight for controlled migration 048.
// Reports schema metadata and row counts only; never prints prompts or audit payloads.
const fs = require('node:fs');
const path = require('node:path');
const { cleanConnectionString } = require('../utils/databaseUrl');
const {
  AI_AUDIT_TELEMETRY_SCHEMA, AI_AUDIT_TELEMETRY_COLUMNS,
  AI_AUDIT_LEGACY_COLUMNS, AI_AUDIT_REQUIRED_INDEXES,
  AI_AUDIT_COLUMN_TYPE_OPTIONS, isAiAuditIndexDefinitionValid, migrationChecksum,
} = require('../migrations/forwardMigrationRunner');

async function main() {
  let database;
  if (process.argv.includes('--test')) {
    const { loadTestEnvironment, runPreflight } = require('./paymentTestDatabasePreflight');
    const env = loadTestEnvironment();
    // Require the test project's explicit authorization and in-DB identity marker
    // before connecting the audit schema verifier to that isolated project.
    await runPreflight({ env });
    const { Pool } = require('pg');
    database = new Pool({
      connectionString: cleanConnectionString(env.TEST_DATABASE_URL),
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
      statement_timeout: 15000,
      max: 1,
      application_name: 'smarterp-ai-audit-schema-preflight',
    });
  } else {
    database = require('../db-base').pool;
  }

  let client;
  try {
    client = await database.connect();
    await client.query('BEGIN READ ONLY');
    const tableCheck = await client.query("SELECT to_regclass('public.ai_audit_logs') IS NOT NULL AS exists");
    const exists = tableCheck.rows[0]?.exists === true;
    const status = { migration: AI_AUDIT_TELEMETRY_SCHEMA.id, tableExists: exists };

    const historyExists = (await client.query("SELECT to_regclass('public.app_migration_history') IS NOT NULL AS exists")).rows[0]?.exists;
    if (historyExists) {
      const history = await client.query(
        'SELECT checksum_sha256 FROM public.app_migration_history WHERE migration_id = $1',
        [AI_AUDIT_TELEMETRY_SCHEMA.id]
      );
      status.forwardLedger = history.rows.length ? 'applied' : 'not_applied';
      if (history.rows[0]) {
        const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', AI_AUDIT_TELEMETRY_SCHEMA.file), 'utf8');
        status.checksumMatchesWorkspace = String(history.rows[0].checksum_sha256).trim() === migrationChecksum(sql);
      }
    } else {
      status.forwardLedger = 'missing';
    }

    if (exists) {
      const columnsResult = await client.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_audit_logs'"
      );
      const columns = new Map(columnsResult.rows.map((row) => [row.column_name, row]));
      const indexResult = await client.query(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='ai_audit_logs'"
      );
      const indexes = new Map(indexResult.rows.map((row) => [row.indexname, row.indexdef]));
      const counts = await client.query(`
        SELECT COUNT(*)::bigint AS row_count,
               COUNT(*) FILTER (WHERE user_id IS NULL)::bigint AS null_user_id_count,
               COUNT(*) FILTER (WHERE company_id IS NULL)::bigint AS null_company_id_count
          FROM public.ai_audit_logs
      `);
      status.missingTelemetryColumns = AI_AUDIT_TELEMETRY_COLUMNS.filter((name) => !columns.has(name));
      status.missingLegacyColumns = AI_AUDIT_LEGACY_COLUMNS.filter((name) => !columns.has(name));
      status.missingIndexes = AI_AUDIT_REQUIRED_INDEXES.filter((name) => !indexes.has(name));
      status.invalidIndexes = AI_AUDIT_REQUIRED_INDEXES.filter((name) => !isAiAuditIndexDefinitionValid(name, indexes.get(name)));
      status.wrongColumnTypes = Object.entries(AI_AUDIT_COLUMN_TYPE_OPTIONS).filter(([name, types]) =>
        columns.has(name) && !types.includes(columns.get(name).data_type)
      ).map(([name]) => name);
      status.companyIdType = columns.get('company_id')?.data_type || null;
      status.legacyNotNullColumns = ['role', 'prompt', 'action_name'].filter((name) => columns.get(name)?.is_nullable === 'NO');
      status.rows = counts.rows[0];
    }

    await client.query('ROLLBACK');
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    const preflightOk = exists
      ? status.missingLegacyColumns.length === 0
        && status.missingTelemetryColumns.length === 0
        && status.missingIndexes.length === 0
        && status.invalidIndexes.length === 0
        && status.wrongColumnTypes.length === 0
        && status.companyIdType === 'text'
        && status.legacyNotNullColumns.length === 0
        && status.checksumMatchesWorkspace !== false
      : status.forwardLedger === 'not_applied';
    if (!preflightOk) process.exitCode = 2;
  } finally {
    if (client) client.release();
    await database.end().catch(() => {});
  }
}

main().catch((error) => {
  const safeCode = error?.code
    || error?.cause?.code
    || String(error?.message || '').match(/\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET)\b/)?.[1]
    || error?.name
    || 'database error';
  process.stderr.write(`Read-only AI audit schema preflight failed: ${safeCode}\n`);
  process.exitCode = 1;
});
