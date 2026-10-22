const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FORWARD_MIGRATIONS, STARTUP_MIGRATIONS } = require('../migrations/forwardMigrationRunner');

test('042 is allow-listed for controlled execution and verifies password-reset OTP schema', () => {
  const id = '042_staff_password_reset_otp_scope';
  assert.equal(FORWARD_MIGRATIONS.some((migration) => migration.id === id), true);
  assert.equal(STARTUP_MIGRATIONS.some((migration) => migration.id === id), false);

  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', `${id}.sql`), 'utf8');
  assert.match(sql, /ALTER COLUMN otp_code TYPE TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS purpose VARCHAR\(32\) NOT NULL DEFAULT 'email_verification'/);
  assert.match(sql, /idx_email_otps_staff_purpose_lookup/);
});
