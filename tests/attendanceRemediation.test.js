const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AttendancePolicy = require('../services/attendancePolicyService');
const AttendanceAccess = require('../services/attendanceAccess');
const BiometricAuth = require('../services/biometricWebhookAuth');

const ist = (date, time) => AttendancePolicy.zonedDateTimeToUtc(date, time, 'Asia/Kolkata');
const source = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('HR analytics authorization is limited to owner, admin, and HR roles', () => {
  for (const role of ['owner', 'admin', 'hr', 'OWNER', 'HR']) assert.equal(AttendanceAccess.canAccessHrAnalytics(role), true);
  for (const role of ['employee', 'customer', 'super_admin', undefined, '']) assert.equal(AttendanceAccess.canAccessHrAnalytics(role), false);
  assert.match(source('routes', 'hr.js'), /canAccessHrAnalytics\(req\.user\.role\)/);
});

test('attendance report ranges use company-local work date and stable date-only boundaries', () => {
  assert.deepEqual(AttendanceAccess.dateRangeForWorkDate('week', '2026-10-18'), { startDate: '2026-10-11', endDate: '2026-10-18' });
  assert.deepEqual(AttendanceAccess.dateRangeForWorkDate('month', '2026-10-18'), { startDate: '2026-09-18', endDate: '2026-10-18' });
  assert.equal(AttendancePolicy.localDate(new Date('2026-10-17T18:31:00.000Z')), '2026-10-18');
  assert.match(source('routes', 'reports.js'), /dateRangeFilter\(period, 'a\.date', 2, workDate\)/);
});

test('attendance report and listed readers include row-company predicates', () => {
  const required = [
    ['routes', 'dashboard.js', /u\.company_id::text = a\.company_id::text/],
    ['routes', 'commandCenter.js', /company_id::text = \$1::text/],
    ['routes', 'reports.js', /a\.company_id::text = u\.company_id::text/],
    ['routes', 'payroll.js', /company_id::text = \$2::text/],
    ['routes', 'attendance.js', /u\.company_id::text = a\.company_id::text/],
    ['services', 'aiDataService.js', /a\.company_id::text = u\.company_id::text/],
    ['services', 'notificationRoutingService.js', /a\.company_id::text = u\.company_id::text/],
  ];
  for (const [dir, file, pattern] of required) assert.match(source(dir, file), pattern, `${dir}/${file} must scope attendance to the employee company`);
});

test('approved leave changes a same-day absent row whether approval precedes or follows scheduled processing', async () => {
  for (const processed of [false, true]) {
    const workDate = '2026-10-18';
    let row = { id: 'a1', status: 'absent', is_processed: processed };
    const calls = [];
    const queryable = { async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM company_settings')) return { rows: [] };
      if (sql.includes("FROM users WHERE role = 'employee'")) return { rows: [{ id: 'e1' }] };
      if (sql.includes('FROM attendance WHERE user_id')) return { rows: [row] };
      if (sql.includes('FROM hr_employee_requests')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes("SET status = 'leave'")) { row = { ...row, status: 'leave' }; return { rows: [{ ...row }] }; }
      return { rows: [] };
    } };
    await AttendancePolicy.processCompanyDate('c1', workDate, queryable, ist(workDate, '19:01'));
    assert.equal(row.status, 'leave');
    assert.ok(calls.some((call) => call.sql.includes("SET status = 'leave'") && call.params[2] === workDate));
  }
});

test('approved leave never rewrites a historical absent row', async () => {
  let row = { id: 'a1', status: 'absent', is_processed: true };
  const queryable = { async query(sql) {
    if (sql.includes('FROM company_settings')) return { rows: [] };
    if (sql.includes("FROM users WHERE role = 'employee'")) return { rows: [{ id: 'e1' }] };
    if (sql.includes('FROM attendance WHERE user_id')) return { rows: [row] };
    if (sql.includes('FROM hr_employee_requests')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes("SET status = 'leave'")) { row = { ...row, status: 'leave' }; return { rows: [{ ...row }] }; }
    return { rows: [] };
  } };
  await AttendancePolicy.processCompanyDate('c1', '2026-10-17', queryable, ist('2026-10-18', '19:01'));
  assert.equal(row.status, 'absent');
});

test('approved leave before daily absence processing does not create an absent row', async () => {
  let absenceInserts = 0;
  const queryable = { async query(sql) {
    if (sql.includes('FROM company_settings')) return { rows: [] };
    if (sql.includes("FROM users WHERE role = 'employee'")) return { rows: [{ id: 'e1' }] };
    if (sql.includes('FROM attendance WHERE user_id')) return { rows: [] };
    if (sql.includes('FROM hr_employee_requests')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('INSERT INTO attendance')) { absenceInserts += 1; return { rows: [{ id: 'a1' }] }; }
    return { rows: [] };
  } };
  const outcome = await AttendancePolicy.processCompanyDate('c1', '2026-10-18', queryable, ist('2026-10-18', '19:01'));
  assert.equal(outcome.marked_absent, 0);
  assert.equal(absenceInserts, 0);
});

test('delayed automatic clock-out retries at the stored 19:00 cutoff and is idempotent', async () => {
  let row = { id: 'a1', check_in_time: ist('2026-10-18', '09:10'), check_out_time: null, is_processed: false };
  let clockOutWrites = 0;
  const queryable = { async query(sql) {
    if (sql.includes('FROM company_settings')) return { rows: [] };
    if (sql.includes("FROM users WHERE role = 'employee'")) return { rows: [{ id: 'e1' }] };
    if (sql.includes('FROM attendance WHERE user_id')) return { rows: [{ ...row }] };
    if (sql.includes('UPDATE attendance SET check_out_time')) {
      clockOutWrites += 1;
      row = { ...row, check_out_time: ist('2026-10-18', '19:00'), is_processed: false };
      return { rows: [{ id: 'a1' }] };
    }
    if (sql.includes('UPDATE attendance SET is_processed')) { row.is_processed = true; return { rows: [{ id: 'a1' }] }; }
    return { rows: [] };
  } };
  const delayed = ist('2026-10-18', '19:17');
  const first = await AttendancePolicy.processCompanyDate('c1', '2026-10-18', queryable, delayed);
  const retry = await AttendancePolicy.processCompanyDate('c1', '2026-10-18', queryable, delayed);
  assert.equal(first.auto_clocked_out, 1);
  assert.equal(retry.auto_clocked_out, 0);
  assert.equal(clockOutWrites, 1);
  assert.equal(row.check_out_time.getTime(), ist('2026-10-18', '19:00').getTime());
  assert.equal(AttendancePolicy.automaticClockOutFor('2026-10-18', ist('2026-10-18', '19:00')).due, true);
  assert.match(source('jobs', 'dailyAttendanceProcessor.js'), /cron\.schedule\('\* \* \* \* \*'/);
});

test('biometric webhook is opt-in and replay/signature helpers reject replay', async () => {
  assert.equal(BiometricAuth.isWebhookEnabled(undefined, undefined), false);
  assert.equal(BiometricAuth.isWebhookEnabled('true', undefined), false);
  assert.equal(BiometricAuth.isWebhookEnabled('false', 'true'), false);
  assert.equal(BiometricAuth.isWebhookEnabled('true', 'true'), true);
  assert.match(source('routes', 'attendance.js'), /isWebhookEnabled\(process\.env\.BIOMETRIC_WEBHOOK_ENABLED, process\.env\.BIOMETRIC_GATEWAY_CONTRACT_VERIFIED\)/);
  const redis = { status: 'ready', async set(key, value, nx, ex, ttl) { if (this[key]) return null; this[key] = value; return 'OK'; } };
  assert.equal(await BiometricAuth.claimNonce(redis, 'nonce_123456789012'), 'claimed');
  assert.equal(await BiometricAuth.claimNonce(redis, 'nonce_123456789012'), 'replayed');
});

