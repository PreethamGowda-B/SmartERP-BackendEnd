const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePayroll } = require('../services/payrollAnomalyEngine');
const PayrollValidationService = require('../services/payrollValidationService');
const { approvalBlockReason } = require('../services/payrollAuditApproval');

const payrollRow = (overrides = {}) => ({
  id: 'pay-1', employee_id: 'emp-1', employee_email: 'employee@example.test', employee_name: 'Employee One',
  base_salary: '20000', extra_amount: '0', salary_increment: '0', deduction: '0', total_salary: '20000',
  present_days: 20, absent_days: 0, half_days: 0, ...overrides,
});
const employee = (overrides = {}) => ({
  id: 'emp-1', name: 'Employee One', email: 'employee@example.test', is_active: true,
  profile_is_active: true, phone: null, identifiers: [], ...overrides,
});
const analyze = (options = {}) => analyzePayroll({
  payroll: [payrollRow()], employees: [employee()], attendance: [], previousPayroll: [], exits: [],
  capabilities: { bankOrPan: true }, period: { month: 5, year: 2026 }, now: new Date('2026-10-16T00:00:00Z'),
  ...options,
});
const check = (report, id) => report.checks.find((item) => item.id === id);

test('1. detects a duplicated normalized bank account and masks it', () => {
  const report = analyze({
    payroll: [payrollRow(), payrollRow({ id: 'pay-2', employee_id: 'emp-2', employee_email: 'two@example.test' })],
    employees: [employee({ identifiers: [{ type: 'bank_account', value: '00 1234-5678' }] }), employee({ id: 'emp-2', email: 'two@example.test', identifiers: [{ type: 'bank_account', value: '0012345678' }] })],
  });
  const flags = report.findings.filter((finding) => finding.flag_type === 'duplicate_bank');
  assert.equal(flags.length, 2);
  assert.equal(flags[0].details.masked_identifier, '••••5678');
  assert.equal(JSON.stringify(flags).includes('0012345678'), false);
});

test('2. normalizes duplicate PAN and phone values while ignoring blanks', () => {
  const report = analyze({
    payroll: [payrollRow(), payrollRow({ id: 'pay-2', employee_id: 'emp-2', employee_email: 'two@example.test' }), payrollRow({ id: 'pay-3', employee_id: 'emp-3', employee_email: 'three@example.test' })],
    employees: [
      employee({ phone: '+91 98765 43210', identifiers: [{ type: 'pan', value: 'ABCDE1234F' }] }),
      employee({ id: 'emp-2', email: 'two@example.test', phone: '9876543210', identifiers: [{ type: 'pan', value: 'abcde-1234-f' }] }),
      employee({ id: 'emp-3', email: 'three@example.test', phone: '', identifiers: [{ type: 'pan', value: 'N/A' }] }),
    ],
  });
  assert.equal(report.findings.filter((finding) => finding.details.identifier_type === 'phone').length, 2);
  assert.equal(report.findings.filter((finding) => finding.details.identifier_type === 'pan').length, 2);
  assert.ok(report.findings.every((finding) => !finding.description.includes('ABCDE1234F')));
});

test('3. detects a gross earnings increase above 25% against the immediately previous period', () => {
  const report = analyze({
    payroll: [payrollRow({ base_salary: '2000000', total_salary: '2000000' })],
    previousPayroll: [payrollRow({ id: 'pay-oct', base_salary: '20000', total_salary: '20000', payroll_month: 10, payroll_year: 2026 })],
    period: { month: 11, year: 2026 },
  });
  const finding = report.findings.find((item) => item.flag_type === 'salary_spike');
  assert.equal(finding.details.previous_amount, 20000);
  assert.equal(finding.details.current_amount, 2000000);
  assert.equal(finding.details.change_percent, 9900);
});

test('3b. marks a current-period new hire as not comparable but does not hide a missing baseline for an existing employee', () => {
  const newHire = analyze({
    employees: [employee({ created_at: '2026-05-04T00:00:00Z' })],
  });
  assert.equal(check(newHire, 'salary_spike').status, 'passed');
  assert.match(check(newHire, 'salary_spike').explanation, /1 new hires had no prior baseline/);
  const missingHistory = analyze({ employees: [employee({ created_at: '2023-01-01T00:00:00Z' })] });
  assert.equal(check(missingHistory, 'salary_spike').status, 'unable_to_validate');
  assert.match(check(missingHistory, 'salary_spike').explanation, /1 other records lacked a valid baseline/);
});

test('4. identifies inactive employee payouts and permits a matching approved final settlement', () => {
  const inactive = analyze({ employees: [employee({ is_active: false })] });
  assert.equal(inactive.findings.find((item) => item.flag_type === 'inactive_user').details.payout_amount, 20000);
  const settled = analyze({ employees: [employee({ is_active: false })], exits: [{ user_id: 'emp-1', status: 'approved', fnf_amount: '20000' }] });
  assert.equal(settled.findings.some((item) => item.flag_type === 'inactive_user'), false);
});

test('5. flags stored payroll attendance totals that disagree with actual attendance', () => {
  const report = analyze({
    attendance: [{ user_id: 'emp-1', status: 'present' }, { user_id: 'emp-1', status: 'absent' }],
  });
  const finding = report.findings.find((item) => item.flag_type === 'attendance_mismatch');
  assert.deepEqual(finding.details.attendance_records, { present: 1, absent: 1, half_day: 0, other: 0 });
});

test('6. does not pass statutory calculations when no statutory policy or breakdown is available', () => {
  const report = analyze();
  assert.equal(check(report, 'statutory_calculation').status, 'unable_to_validate');
});

test('7. detects negative net payouts and arithmetic inconsistencies', () => {
  const negative = analyze({ payroll: [payrollRow({ deduction: '21000', total_salary: '-1000' })] });
  assert.equal(check(negative, 'invalid_payout').status, 'failed');
  const inconsistent = analyze({ payroll: [payrollRow({ extra_amount: '4000', deduction: '100', total_salary: '3900' })] });
  assert.equal(inconsistent.findings.find((item) => item.flag_type === 'negative_payout').details.expected_net, 23900);
});

test('8. flags zero gross and zero net payout for active employees', () => {
  const zeroGross = analyze({ payroll: [payrollRow({ base_salary: '0', total_salary: '0' })] });
  assert.equal(zeroGross.findings.find((item) => item.flag_type === 'zero_salary').details.gross_earnings, 0);
  const zeroNet = analyze({ payroll: [payrollRow({ deduction: '20000', total_salary: '0' })] });
  assert.match(zeroNet.findings.find((item) => item.flag_type === 'zero_salary').description, /zero net payout/);
});

test('9. reports no payroll records instead of treating the checks as passed', () => {
  const report = analyze({ payroll: [], employees: [] });
  assert.equal(report.overallStatus, 'no_records');
  assert.ok(report.checks.every((item) => item.status !== 'passed'));
});

test('10. missing attendance remains unable to validate and is never passed', () => {
  const report = analyze({ attendance: [], attendanceAvailable: true });
  assert.equal(check(report, 'attendance_mismatch').status, 'unable_to_validate');
  const failedSource = analyze({ attendance: [], attendanceAvailable: false });
  assert.match(check(failedSource, 'attendance_mismatch').explanation, /query failed/);
  assert.equal(check(failedSource, 'attendance_mismatch').status, 'unable_to_validate');
});

test('11. payroll source database errors reject instead of creating a passing report', async () => {
  const client = { query: async () => { throw Object.assign(new Error('database unavailable'), { code: '08006' }); } };
  await assert.rejects(PayrollValidationService.readSources(client, 'company-a', 5, 2026), /database unavailable/);
});

test('12. correctly calculated payroll passes its arithmetic check', () => {
  const report = analyze({ payroll: [payrollRow({ base_salary: '20000', extra_amount: '4000', deduction: '100', total_salary: '23900' })] });
  assert.equal(check(report, 'invalid_payout').status, 'passed');
  assert.equal(check(report, 'invalid_payout').findings_count, 0);
});

test('13. zero attendance pay is not prorated because the configured Payroll Console rule is explicit deductions only', () => {
  const report = analyze({
    payroll: [payrollRow({ present_days: 0, absent_days: 20, total_salary: '20000' })],
    attendance: Array.from({ length: 20 }, () => ({ user_id: 'emp-1', status: 'absent' })),
  });
  assert.equal(check(report, 'attendance_mismatch').status, 'passed');
  assert.equal(report.findings.some((item) => item.flag_type === 'attendance_mismatch'), false);
});

test('14. company scope is a required predicate on the source payroll query', async () => {
  let payrollQuery = '';
  let payrollParams = [];
  const client = { query: async (sql, params = []) => {
    if (sql.includes('FROM payroll p')) { payrollQuery = sql; payrollParams = params; return { rows: [] }; }
    if (sql.includes('information_schema.columns')) return { rows: [] };
    return { rows: [] };
  } };
  await PayrollValidationService.readSources(client, 'tenant-1', 5, 2026);
  assert.match(payrollQuery, /p\.company_id::text = \$1::text/);
  assert.equal(payrollParams[0], 'tenant-1');
});

test('15. fingerprints change when payroll inputs change, making prior audits stale', () => {
  const before = PayrollValidationService.fingerprint({ amount: '20000' });
  const after = PayrollValidationService.fingerprint({ amount: '20001' });
  assert.notEqual(before, after);
});

test('16. critical unresolved findings, incomplete checks, stale data, and future periods block approval', () => {
  const passed = {
    audit_status: 'passed', checks_executed: 7, record_count: 1, year: 2026, month: 5, is_approved: false,
    check_results: Array.from({ length: 7 }, () => ({ status: 'passed' })),
  };
  assert.match(approvalBlockReason({ ...passed, unresolved_critical_count: 1 }, new Date('2026-10-16')), /critical/);
  assert.match(approvalBlockReason({ ...passed, audit_status: 'unable_to_validate' }, new Date('2026-10-16')), /seven checks/);
  assert.match(approvalBlockReason({ ...passed, is_stale: true }, new Date('2026-10-16')), /changed/);
  assert.match(approvalBlockReason({ ...passed, month: 11 }, new Date('2026-10-16')), /Future/);
  assert.equal(approvalBlockReason({ ...passed, unresolved_critical_count: 0 }, new Date('2026-10-16')), null);
});

test('17. audit result model always exposes all seven persisted check statuses', () => {
  const report = analyze();
  assert.equal(report.checks.length, 7);
  assert.deepEqual(report.checks.map((item) => item.id), [
    'duplicate_identifiers', 'salary_spike', 'inactive_employee', 'attendance_mismatch',
    'statutory_calculation', 'invalid_payout', 'zero_salary',
  ]);
  assert.ok(report.checks.every((item) => typeof item.status === 'string' && typeof item.explanation === 'string'));
});
