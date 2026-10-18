const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  PRODUCTION_DISPATCH,
  PRODUCTION_DISPATCH_PRIVILEGES,
  stripOuterTransaction,
  migrationChecksum,
  applyForwardMigration,
} = require('../migrations/forwardMigrationRunner');

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', PRODUCTION_DISPATCH.file), 'utf8');
const privilegeSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', PRODUCTION_DISPATCH_PRIVILEGES.file), 'utf8');

function fakeClient({ existingChecksum = null, hasObjects = false, legacyLedger = false, legacyApplied = false } = {}) {
  const calls = [];
  const client = {
    calls,
    async query(queryText, params = []) {
      calls.push({ queryText, params });
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
        return { rows: hasObjects ? [{ name: PRODUCTION_DISPATCH.tables[0] }] : [] };
      }
      if (queryText.includes("to_regprocedure('public.production_reject_history_mutation()') IS NOT NULL AS exists")) {
        return { rows: [{ exists: false }] };
      }
      if (queryText.includes('SELECT\n      (SELECT COUNT(*)::int FROM pg_class')) {
        return { rows: [{
          table_count: 10, rls_count: 10, policy_count: 10, index_count: 11,
          trigger_count: 5, constraint_count: 57, foreign_key_count: 22,
          history_function: true, app_role_safe: true,
          app_schema_usage: true, app_grant_count: 10,
        }] };
      }
      if (queryText.includes('app_read_insert_count')) {
        return { rows: [{
          app_read_insert_count: 10, app_update_count: 3,
          unexpected_app_update_count: 0, unexpected_app_privilege_count: 0,
          external_role_privilege_count: 0, public_acl_count: 0,
        }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return client;
}

test('strips only outer transaction markers and keeps procedural blocks', () => {
  const cleaned = stripOuterTransaction(sql);
  assert.doesNotMatch(cleaned, /^BEGIN\s*;/i);
  assert.doesNotMatch(cleaned, /COMMIT\s*;\s*$/i);
  assert.match(cleaned, /DO \$\$[\s\S]*?BEGIN/);
});

test('applies the allow-listed migration and records it only after verification', async () => {
  const client = fakeClient();
  const result = await applyForwardMigration(client, { migrationId: PRODUCTION_DISPATCH.id, sql });
  assert.equal(result.status, 'applied');
  const migrationIndex = client.calls.findIndex(call => call.queryText.includes('CREATE TABLE IF NOT EXISTS production_sequences'));
  const recordIndex = client.calls.findIndex(call => call.queryText.includes('INSERT INTO app_migration_history'));
  assert.ok(migrationIndex >= 0 && recordIndex > migrationIndex);
  assert.equal(client.calls.at(-1).queryText, 'COMMIT');
});

test('rejects schema drift before executing SQL and rolls back', async () => {
  const client = fakeClient({ hasObjects: true });
  await assert.rejects(
    applyForwardMigration(client, { migrationId: PRODUCTION_DISPATCH.id, sql }),
    /Untracked Production & Dispatch objects already exist/
  );
  assert.equal(client.calls.some(call => call.queryText.includes('CREATE TABLE IF NOT EXISTS production_sequences')), false);
  assert.equal(client.calls.at(-1).queryText, 'ROLLBACK');
});

test('refuses an already-recorded migration whose file checksum changed', async () => {
  const client = fakeClient({ existingChecksum: 'f'.repeat(64) });
  await assert.rejects(
    applyForwardMigration(client, { migrationId: PRODUCTION_DISPATCH.id, sql }),
    /Checksum mismatch/
  );
  assert.equal(client.calls.at(-1).queryText, 'ROLLBACK');
});

test('adopts a legacy-recorded 033 only after complete schema verification', async () => {
  const client = fakeClient({ legacyLedger: true, legacyApplied: true });
  const result = await applyForwardMigration(client, { migrationId: PRODUCTION_DISPATCH.id, sql });
  assert.equal(result.status, 'adopted_verified_legacy_record');
  assert.equal(client.calls.some(call => call.queryText.includes('CREATE TABLE IF NOT EXISTS production_sequences')), false);
  assert.equal(client.calls.some(call => call.queryText.includes('INSERT INTO app_migration_history')), true);
});

test('applies the scoped production grants and verifies no tenant-unsafe privileges remain', async () => {
  const client = fakeClient();
  const result = await applyForwardMigration(client, {
    migrationId: PRODUCTION_DISPATCH_PRIVILEGES.id,
    sql: privilegeSql,
  });
  assert.equal(result.status, 'applied');
  assert.equal(client.calls.some(call => call.queryText.includes('REVOKE ALL PRIVILEGES')), true);
  assert.equal(client.calls.some(call => call.queryText.includes('app_read_insert_count')), true);
});

test('refuses migration IDs outside the reviewed allow-list', async () => {
  await assert.rejects(
    applyForwardMigration(fakeClient(), { migrationId: '001_anything', sql }),
    /not in the reviewed forward-migration allow-list/
  );
});

test('checksum is stable for the exact migration source', () => {
  assert.equal(migrationChecksum(sql), migrationChecksum(sql));
  assert.notEqual(migrationChecksum(sql), migrationChecksum(`${sql}\n`));
});
