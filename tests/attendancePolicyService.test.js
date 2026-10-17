const test = require('node:test');
const assert = require('node:assert/strict');
const AttendancePolicy = require('../services/attendancePolicyService');

const ist = (date, time) => AttendancePolicy.zonedDateTimeToUtc(date, time, 'Asia/Kolkata');

test('approved defaults are explicit and validated', () => {
  const policy = AttendancePolicy.validatePolicy();
  assert.equal(policy.timezone, 'Asia/Kolkata');
  assert.equal(policy.shiftStart, '09:00');
  assert.equal(policy.shiftEnd, '19:00');
  assert.equal(policy.clockInCutoff, '11:00');
  assert.equal(policy.automaticClockOutTime, '19:00');
  assert.equal(policy.gracePeriodMinutes, 0);
});

test('clock-in eligibility enforces earliest, exact start, late window and hard cutoff', () => {
  const date = '2026-10-17';
  assert.equal(AttendancePolicy.evaluateClockIn(ist(date, '08:59')).code, 'too_early');
  assert.equal(AttendancePolicy.evaluateClockIn(ist(date, '09:00')).is_late, false);
  assert.equal(AttendancePolicy.evaluateClockIn(new Date(ist(date, '09:00').getTime() + 1000)).is_late, true);
  assert.equal(AttendancePolicy.evaluateClockIn(ist(date, '09:01')).is_late, true);
  assert.equal(AttendancePolicy.evaluateClockIn(ist(date, '11:00')).allowed, true);
  assert.equal(AttendancePolicy.evaluateClockIn(new Date(ist(date, '11:00').getTime() + 1000)).code, 'cutoff_passed');
  assert.equal(AttendancePolicy.evaluateClockIn(ist(date, '11:01')).code, 'cutoff_passed');
});

test('half-day boundary and early departure status are consistent', () => {
  const date = '2026-10-17';
  assert.equal(AttendancePolicy.classifyStatus(ist(date, '13:00'), ist(date, '19:00')), 'half_day');
  assert.equal(AttendancePolicy.classifyStatus(ist(date, '09:00'), ist(date, '18:59')), 'half_day');
  assert.equal(AttendancePolicy.classifyStatus(ist(date, '09:01'), ist(date, '19:00')), 'late');
  assert.equal(AttendancePolicy.classifyStatus(null, null), 'absent');
});

test('elapsed hours use persisted instants and round to two decimals without break deduction', () => {
  const inAt = ist('2026-10-17', '09:00');
  const outAt = ist('2026-10-17', '18:59');
  assert.equal(AttendancePolicy.calculateWorkingHours(inAt, outAt), 9.98);
  assert.throws(() => AttendancePolicy.calculateWorkingHours(outAt, inAt), /Invalid attendance time range/);
});

test('IST local work date is stable across UTC midnight boundary', () => {
  const beforeUtcMidnight = new Date('2026-10-17T18:29:00.000Z');
  const afterUtcMidnight = new Date('2026-10-17T18:31:00.000Z');
  assert.equal(AttendancePolicy.localDate(beforeUtcMidnight), '2026-10-17');
  assert.equal(AttendancePolicy.localDate(afterUtcMidnight), '2026-10-18');
});

test('policy rejects unapproved timezone, unknown fields and invalid time ordering', () => {
  assert.throws(() => AttendancePolicy.validatePolicy({ timezone: 'UTC' }), /fixed to Asia\/Kolkata/);
  assert.throws(() => AttendancePolicy.validatePolicy({ company_id: 'other-tenant' }), /Unknown attendance policy field/);
  assert.throws(() => AttendancePolicy.validatePolicy({ shiftStart: '20:00' }), /Overnight shifts are not supported/);
});

test('policy storage query is always keyed by company id and fixed setting key', async () => {
  const calls = [];
  const queryable = { query: async (...args) => { calls.push(args); return { rows: [] }; } };
  await AttendancePolicy.getCompanyPolicy('company-a', queryable);
  assert.deepEqual(calls[0][1], ['company-a', 'attendance_policy']);
  await assert.rejects(AttendancePolicy.getCompanyPolicy(null, queryable), /Missing company affiliation/);
});

test('daily processing remains tenant-scoped, skips approved leave and closes one open session', async () => {
  const calls = [];
  const checkIn = ist('2026-10-17', '09:05');
  const queryable = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM company_settings')) return { rows: [] };
      if (sql.includes("FROM users WHERE role = 'employee'")) return { rows: [{ id: 'employee-a' }, { id: 'employee-b' }] };
      if (sql.includes('FROM attendance WHERE user_id')) {
        assert.equal(String(params[1]), 'company-a');
        return params[0] === 'employee-a'
          ? { rows: [{ id: 'attendance-1', user_id: 'employee-a', check_in_time: checkIn, check_out_time: null, is_processed: false }] }
          : { rows: [] };
      }
      if (sql.includes('FROM hr_employee_requests')) {
        assert.equal(String(params[0]), 'company-a');
        return { rows: [{ '?column?': 1 }] };
      }
      if (sql.includes('UPDATE attendance SET check_out_time')) return { rows: [{ id: 'attendance-1' }] };
      if (sql.includes('UPDATE attendance SET is_processed')) return { rows: [{ id: 'attendance-1' }] };
      return { rows: [] };
    },
  };
  const result = await AttendancePolicy.processCompanyDate('company-a', '2026-10-17', queryable, ist('2026-10-17', '19:01'));
  assert.equal(result.auto_clocked_out, 1);
  assert.equal(result.marked_absent, 0);
  assert.equal(result.records_locked, 1);
  assert.ok(calls.filter((c) => c.sql.includes('FROM attendance WHERE user_id')).every((c) => String(c.params[1]) === 'company-a'));
});

test('daily processing does not write before configured clock-out cutoff', async () => {
  let writes = 0;
  const queryable = { async query(sql) {
    if (sql.includes('FROM company_settings')) return { rows: [] };
    if (sql.includes('UPDATE') || sql.includes('INSERT')) writes += 1;
    return { rows: [] };
  } };
  const result = await AttendancePolicy.processCompanyDate('company-a', '2026-10-17', queryable, ist('2026-10-17', '18:59'));
  assert.equal(result.due, false);
  assert.equal(writes, 0);
});

test('missed historical processing pauses when company policy changed after the target date', async () => {
  const queryable = { async query(sql) {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM company_settings')) return { rows: [{ setting_value: JSON.stringify(AttendancePolicy.validatePolicy()), updated_at: ist('2026-10-18', '08:00') }] };
    throw new Error('historical policy mismatch must stop before employee queries');
  } };
  const result = await AttendancePolicy.processCompanyDate('company-a', '2026-10-17', queryable, ist('2026-10-18', '10:00'));
  assert.equal(result.due, false);
  assert.equal(result.policy_changed, true);
});
