'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FORWARD_MIGRATIONS,
  STARTUP_MIGRATIONS,
  SUPERADMIN_ANNOUNCEMENTS_SETTINGS,
} = require('../migrations/forwardMigrationRunner');

const migrationPath = path.join(__dirname, '..', 'migrations', SUPERADMIN_ANNOUNCEMENTS_SETTINGS.file);
const sql = fs.readFileSync(migrationPath, 'utf8');

test('migration 041 is registered after controlled 039, and 039/041/042 remain out of startup', () => {
  const ids = FORWARD_MIGRATIONS.map(({ id }) => id);
  assert.ok(ids.indexOf('041_superadmin_announcements_and_system_settings') > ids.indexOf('038_tiered_support_entitlements'));
  assert.ok(ids.indexOf('042_staff_password_reset_otp_scope') > ids.indexOf('041_superadmin_announcements_and_system_settings'));
  assert.equal(ids.includes('039_invoice_payment_idempotency'), true);
  assert.equal(ids.includes('040_direct_invoice_idempotency_fingerprint'), false);
  assert.equal(STARTUP_MIGRATIONS.some(({ id }) => id === '039_invoice_payment_idempotency'), false);
  assert.equal(STARTUP_MIGRATIONS.some(({ id }) => id === SUPERADMIN_ANNOUNCEMENTS_SETTINGS.id), false);
});

test('migration 041 creates only announcement/settings schema and preserves existing records', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.announcements/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.system_settings/);
  assert.match(sql, /ON CONFLICT \(key\) DO NOTHING/);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\s+public\.(announcements|system_settings|notifications)\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
});

test('notification idempotency support is validated before reuse and detects duplicates before index creation', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS idempotency_key TEXT/);
  assert.match(sql, /column_type IS DISTINCT FROM 'text'/);
  assert.match(sql, /GROUP BY idempotency_key HAVING COUNT\(\*\) > 1/);
  assert.match(sql, /CREATE UNIQUE INDEX idx_notifications_idempotency/);
  assert.match(sql, /indisvalid AND pi\.indisready AND pi\.indisunique/);
  assert.match(sql, /idx_notifications_idempotency definition/);
});

test('migration 041 enforces Super Admin and company-scoped HR announcement RLS', () => {
  assert.match(sql, /ALTER TABLE public\.announcements ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE public\.announcements FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE public\.system_settings FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /smarterp_041_announcements_company_read/);
  assert.match(sql, /smarterp_041_announcements_company_insert/);
  assert.match(sql, /smarterp_041_announcements_company_delete/);
  assert.match(sql, /company_id::text = NULLIF\(current_setting\('app\.current_company_id', true\), ''\)/);
  assert.match(sql, /current_setting\('app\.current_role', true\) IN \('owner', 'admin', 'hr'\)/);
  assert.match(sql, /GRANT SELECT, INSERT, DELETE ON TABLE public\.announcements TO smarterp_app/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.system_settings TO smarterp_app/);
  assert.match(sql, /key = 'maintenance_mode'/);
  assert.doesNotMatch(sql, /current_setting\('app\.bypass_rls',\s*true\)\s*=\s*'on'/);
});

test('migration 041 accepts the existing varchar(20) and timestamp-without-time-zone announcements contract without rewriting it', () => {
  assert.match(sql, /character_maximum_length IN \(20, 50\)/);
  assert.match(sql, /data_type IN \('timestamp with time zone', 'timestamp without time zone'\)/);
  assert.match(sql, /column_name='updated_at' AND data_type IN \('timestamp with time zone', 'timestamp without time zone'\)/);
  assert.doesNotMatch(sql, /ALTER\s+COLUMN\s+(priority|created_at)\s+TYPE/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS target_role VARCHAR\(50\)/);
  assert.match(sql, /ALTER TABLE public\.announcements ADD COLUMN company_id/);
  assert.match(sql, /announcement_company_id_type IS DISTINCT FROM company_id_type/);
});
