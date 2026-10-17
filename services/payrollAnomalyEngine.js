const CHECKS = [
  { id: 'duplicate_identifiers', label: 'Duplicate bank, PAN, or phone details' },
  { id: 'salary_spike', label: 'Gross earnings increase above 25%' },
  { id: 'inactive_employee', label: 'Inactive employee payout' },
  { id: 'attendance_mismatch', label: 'Payroll and attendance mismatch' },
  { id: 'statutory_calculation', label: 'Statutory calculation validation' },
  { id: 'invalid_payout', label: 'Negative salary or invalid payout' },
  { id: 'zero_salary', label: 'Unexpected zero salary' },
];

const money = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const idOf = (value) => (value == null ? '' : String(value));
const emailOf = (value) => String(value || '').trim().toLowerCase();
const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const INACTIVE_STATUSES = new Set(['inactive', 'terminated', 'separated', 'disabled', 'archived']);
const isInactive = (employee) => employee?.is_active === false || employee?.profile_is_active === false
  || INACTIVE_STATUSES.has(String(employee?.profile_status || '').trim().toLowerCase());
const hasActiveStatus = (employee) => typeof employee?.is_active === 'boolean'
  || typeof employee?.profile_is_active === 'boolean'
  || INACTIVE_STATUSES.has(String(employee?.profile_status || '').trim().toLowerCase());
const grossOf = (row) => {
  const base = money(row.base_salary);
  const extra = money(row.extra_amount);
  const increment = money(row.salary_increment);
  return base == null || extra == null || increment == null
    ? null
    : roundMoney(base + extra + increment);
};
const netOf = (row) => money(row.total_salary);

function employeeFor(row, employeesById, employeesByEmail) {
  return employeesById.get(idOf(row.employee_id)) || employeesByEmail.get(emailOf(row.employee_email)) || null;
}

function result(id, checkedCount, status, explanation, findings = []) {
  return {
    id,
    label: CHECKS.find((check) => check.id === id).label,
    status,
    records_examined: checkedCount,
    findings_count: findings.length,
    explanation,
  };
}

function makeFinding({ type, severity, row, employee, explanation, details = {}, sourceTable = 'payroll' }) {
  return {
    source_table: sourceTable,
    source_record_id: idOf(row.id),
    user_id: employee?.id || row.employee_id || null,
    employee_name: employee?.name || row.employee_name || 'Employee',
    flag_type: type,
    severity,
    description: explanation,
    details,
  };
}

function analyzePayroll({
  payroll = [], employees = [], previousPayroll = [], attendance = [], exits = [], attendanceAvailable = true,
  period = {}, capabilities = {}, now = new Date(),
}) {
  const findings = [];
  const byId = new Map(employees.filter((employee) => employee.id != null).map((employee) => [idOf(employee.id), employee]));
  const byEmail = new Map(employees.filter((employee) => employee.email).map((employee) => [emailOf(employee.email), employee]));
  const previousByEmployee = new Map();
  for (const previous of previousPayroll) {
    const key = idOf(previous.employee_id) || emailOf(previous.employee_email);
    if (!previousByEmployee.has(key)) previousByEmployee.set(key, previous);
  }
  const attendanceByEmployee = new Map();
  for (const row of attendance) {
    const key = idOf(row.user_id);
    const counts = attendanceByEmployee.get(key) || { present: 0, absent: 0, half_day: 0, other: 0, total: 0 };
    const status = String(row.status || '').trim().toLowerCase();
    if (status === 'present') counts.present++;
    else if (status === 'absent') counts.absent++;
    else if (status === 'half_day' || status === 'half-day') counts.half_day++;
    else counts.other++;
    counts.total++;
    attendanceByEmployee.set(key, counts);
  }
  const exitByEmployee = new Map(exits.map((exit) => [idOf(exit.user_id), exit]));
  const scopedEmployees = payroll.map((row) => employeeFor(row, byId, byEmail));

  // 1. Available employee identifiers are phone numbers. The current schema has no employee bank/PAN fields.
  const identifierGroups = new Map();
  const payrollByEmployee = new Map();
  for (let index = 0; index < payroll.length; index++) {
    const key = idOf(scopedEmployees[index]?.id || payroll[index].employee_id) || emailOf(payroll[index].employee_email);
    if (key && !payrollByEmployee.has(key)) payrollByEmployee.set(key, payroll[index]);
  }
  for (const employee of employees) {
    const row = payrollByEmployee.get(idOf(employee.id)) || { id: idOf(employee.id), employee_id: employee.id, employee_name: employee.name };
    const identifiers = [
      { type: 'phone', value: employee?.phone },
      ...(employee?.identifiers || []),
    ];
    for (const identifier of identifiers) {
      const type = String(identifier.type || '').toLowerCase();
      const raw = String(identifier.value || '').trim().toUpperCase();
      if (!raw || ['NA', 'N/A', 'NONE', 'NULL', '-'].includes(raw)) continue;
      let normalized = type === 'pan' ? raw.replace(/[^A-Z0-9]/g, '') : raw.replace(/\D/g, '');
      if (type === 'phone' && normalized.length > 10) normalized = normalized.slice(-10);
      const minLength = type === 'phone' ? 7 : type === 'pan' ? 10 : 6;
      if (normalized.length < minLength) continue;
      const key = `${type}:${normalized}`;
      const group = identifierGroups.get(key) || [];
      group.push({ row, employee, type, normalized, sourceTable: payrollByEmployee.has(idOf(employee.id)) ? 'payroll' : 'users' });
      identifierGroups.set(key, group);
    }
  }
  for (const [key, group] of identifierGroups) {
    const identities = new Set(group.map(({ employee, row }) => idOf(employee?.id || row.employee_id)).filter(Boolean));
    if (identities.size > 1) {
      for (const { row, employee, type, normalized, sourceTable } of group) {
        findings.push(makeFinding({
          type: 'duplicate_bank', severity: type === 'phone' ? 'warning' : 'critical', row, employee,
          explanation: `${type === 'phone' ? 'Phone contact' : type === 'pan' ? 'PAN' : 'Bank account'} matches another employee in the same company; review ownership and legitimacy.`,
          details: { identifier_type: type, masked_identifier: type === 'pan' ? `••••••${normalized.slice(-4)}` : `••••${normalized.slice(-4)}`, duplicate_employee_count: identities.size },
          sourceTable,
        }));
      }
    }
  }
  const duplicateFindings = findings.filter((item) => item.flag_type === 'duplicate_bank');
  const duplicateStatus = payroll.length === 0 ? 'unable_to_validate' : capabilities.bankOrPan
    ? (duplicateFindings.some((item) => item.severity === 'critical') ? 'failed' : duplicateFindings.length ? 'warning' : 'passed')
    : 'unable_to_validate';
  const duplicateExplanation = capabilities.bankOrPan
    ? (duplicateFindings.length ? 'Duplicate normalized identifiers were found; identifiers are masked in results.' : 'Configured identifiers were checked for duplicate values.')
    : 'Phone contacts were checked when present, but employee bank-account and PAN fields are not available in the current schema.';
  const checks = [result('duplicate_identifiers', employees.length, duplicateStatus, duplicateExplanation, duplicateFindings)];

  // 2. Compare gross earnings (base + additions + increments) to the immediately preceding calendar month.
  const priorMonthDate = new Date(Date.UTC(period.year, period.month - 2, 1));
  const priorMonth = priorMonthDate.getUTCMonth() + 1;
  const priorYear = priorMonthDate.getUTCFullYear();
  let spikeExamined = 0;
  const spikeFindings = [];
  let spikeUnverifiable = 0;
  let newHireNotApplicable = 0;
  for (let index = 0; index < payroll.length; index++) {
    const row = payroll[index];
    const employee = scopedEmployees[index];
    const key = idOf(row.employee_id) || emailOf(row.employee_email);
    const previous = previousByEmployee.get(key);
    if (!previous) {
      const hireDate = employee?.hire_date || employee?.created_at;
      const hiredDuringPeriod = hireDate && new Date(hireDate) >= new Date(Date.UTC(period.year, period.month - 1, 1))
        && new Date(hireDate) < new Date(Date.UTC(period.year, period.month, 1));
      if (hiredDuringPeriod) newHireNotApplicable++;
      else spikeUnverifiable++;
      continue;
    }
    spikeExamined++;
    const currentGross = grossOf(row);
    const previousGross = grossOf(previous);
    if (currentGross == null || previousGross == null || previousGross <= 0) {
      spikeUnverifiable++;
      continue;
    }
    const changePercent = roundMoney(((currentGross - previousGross) / previousGross) * 100);
    if (changePercent > 25) {
      const finding = makeFinding({
        type: 'salary_spike', severity: 'warning', row, employee,
        explanation: `Gross earnings increased ${changePercent.toFixed(1)}% from the immediately preceding payroll period. Additions and increments are included; the current schema does not distinguish one-time bonuses or arrears.`,
        details: {
          basis: 'gross_earnings', previous_period: `${priorYear}-${String(priorMonth).padStart(2, '0')}`,
          previous_amount: previousGross, current_amount: currentGross, change_percent: changePercent,
          previous_payroll_id: idOf(previous.id),
        },
      });
      spikeFindings.push(finding);
      findings.push(finding);
    }
  }
  checks.push(result(
    'salary_spike', spikeExamined,
    payroll.length === 0 ? 'unable_to_validate' : (spikeUnverifiable > 0 ? 'unable_to_validate' : (spikeFindings.length ? 'warning' : 'passed')),
    payroll.length === 0 ? 'No payroll records are available for this period.' :
      `${spikeExamined} records compared on gross earnings against ${String(priorMonth).padStart(2, '0')}/${priorYear}; ${newHireNotApplicable} new hires had no prior baseline; ${spikeUnverifiable} other records lacked a valid baseline.`,
    spikeFindings,
  ));

  // 3. Inactive payout, allowing only an approved/cleared F&F record for the same amount.
  let inactiveExamined = 0;
  let inactiveUnavailable = 0;
  const inactiveFindings = [];
  for (let index = 0; index < payroll.length; index++) {
    const row = payroll[index];
    const employee = scopedEmployees[index];
    if (!employee) continue;
    inactiveExamined++;
    if (isInactive(employee)) {
      // Continue to check the final-settlement exemption below.
    } else if (!hasActiveStatus(employee)) { inactiveUnavailable++; continue; }
    else continue;
    const exit = exitByEmployee.get(idOf(employee.id));
    const amount = netOf(row);
    const finalSettlement = ['approved', 'cleared', 'archived'].includes(String(exit?.status || '').toLowerCase())
      && amount != null && money(exit.fnf_amount) != null && Math.abs(amount - money(exit.fnf_amount)) <= 0.01;
    if (finalSettlement) continue;
    const finding = makeFinding({
      type: 'inactive_user', severity: 'critical', row, employee,
      explanation: `Payroll includes an inactive employee${exit ? `; exit record is ${String(exit.status || 'unapproved')}` : '; no approved final-settlement record matches this payout'}.`,
      details: { payout_amount: amount, exit_status: exit?.status || null, final_settlement_amount: money(exit?.fnf_amount) },
    });
    inactiveFindings.push(finding); findings.push(finding);
  }
  checks.push(result('inactive_employee', inactiveExamined, inactiveFindings.length ? 'failed' :
    (inactiveUnavailable === 0 && inactiveExamined === payroll.length && payroll.length > 0 ? 'passed' : 'unable_to_validate'),
  payroll.length === 0 ? 'No payroll records are available for this period.' : 'Employee and profile active status were checked; approved final settlements matching the stored F&F amount are exempt.', inactiveFindings));

  // 4. Compare persisted payroll attendance totals with the attendance table. Salary itself is not attendance-prorated by current payroll rules.
  let attendanceExamined = 0;
  let attendanceUnavailable = 0;
  const attendanceFindings = [];
  for (let index = 0; index < payroll.length; index++) {
    const row = payroll[index];
    const employee = scopedEmployees[index];
    if (!employee) { attendanceUnavailable++; continue; }
    const actual = attendanceAvailable ? attendanceByEmployee.get(idOf(employee.id)) : null;
    if (!actual || actual.total === 0) { attendanceUnavailable++; continue; }
    attendanceExamined++;
    const stored = {
      present: money(row.present_days), absent: money(row.absent_days), half_day: money(row.half_days),
    };
    const missing = Object.values(stored).some((value) => value == null);
    if (missing) { attendanceUnavailable++; continue; }
    if (stored.present !== actual.present || stored.absent !== actual.absent || stored.half_day !== actual.half_day) {
      const finding = makeFinding({
        type: 'attendance_mismatch', severity: 'warning', row, employee,
        explanation: 'Stored payroll attendance totals do not match attendance records for the selected month.',
        details: { payroll_attendance: stored, attendance_records: { present: actual.present, absent: actual.absent, half_day: actual.half_day, other: actual.other } },
      });
      attendanceFindings.push(finding); findings.push(finding);
    }
  }
  checks.push(result('attendance_mismatch', attendanceExamined, payroll.length === 0 || attendanceUnavailable > 0
    ? 'unable_to_validate'
    : (attendanceFindings.length ? 'warning' : 'passed'),
    payroll.length === 0 ? 'No payroll records are available for this period.' : `${attendanceExamined} payroll rows compared with monthly attendance; ${attendanceUnavailable} rows lack a usable attendance source${attendanceAvailable ? '' : ' because the attendance query failed'}. The current payroll creation rule stores attendance for reference and does not automatically prorate salary.`, attendanceFindings));

  // 5. Current schema has no statutory component columns or effective-dated employer statutory policy.
  checks.push(result('statutory_calculation', payroll.length, 'unable_to_validate',
    'PF, ESI, TDS, and other statutory values cannot be recalculated: payroll stores only an aggregate deduction and has no statutory breakdown or company rule source.'));

  // 6. Validate arithmetic and negative components against the actual payroll formula.
  const payoutFindings = [];
  let payoutUnavailable = 0;
  for (let index = 0; index < payroll.length; index++) {
    const row = payroll[index];
    const employee = scopedEmployees[index];
    const base = money(row.base_salary);
    const extra = money(row.extra_amount);
    const increment = money(row.salary_increment);
    const deduction = money(row.deduction);
    const actualNet = netOf(row);
    if ([base, extra, increment, deduction, actualNet].some((value) => value == null)) { payoutUnavailable++; continue; }
    const gross = roundMoney(base + extra + increment);
    const expectedNet = roundMoney(gross - deduction);
    const reasons = [];
    if (base < 0 || extra < 0 || increment < 0 || deduction < 0 || actualNet < 0 || gross < 0) reasons.push('negative payroll component or payout');
    if (Math.abs(actualNet - expectedNet) > 0.01) reasons.push(`stored net ${actualNet.toFixed(2)} does not match gross less deductions ${expectedNet.toFixed(2)}`);
    if (deduction > gross && actualNet >= 0) reasons.push('deductions exceed gross earnings');
    if (reasons.length) {
      const finding = makeFinding({ type: 'negative_payout', severity: 'critical', row, employee,
        explanation: `Invalid payroll amount: ${reasons.join('; ')}.`,
        details: { gross_earnings: gross, deduction, stored_net: actualNet, expected_net: expectedNet },
      });
      payoutFindings.push(finding); findings.push(finding);
    }
  }
  checks.push(result('invalid_payout', payroll.length - payoutUnavailable, payroll.length === 0 || payoutUnavailable > 0
    ? (payoutFindings.length ? 'failed' : 'unable_to_validate')
    : (payoutFindings.length ? 'failed' : 'passed'),
  payroll.length === 0 ? 'No payroll records are available for this period.' : `${payroll.length - payoutUnavailable} records checked using the Payroll Console formula: base + additions + increments - deductions. ${payoutUnavailable} records contained non-numeric amounts.`, payoutFindings));

  // 7. Active employees with a zero gross/net payout require review; inactive records are handled by check 3.
  const zeroFindings = [];
  let zeroExamined = 0;
  let zeroUnavailable = 0;
  for (let index = 0; index < payroll.length; index++) {
    const row = payroll[index];
    const employee = scopedEmployees[index];
    if (!employee || !hasActiveStatus(employee)) { zeroUnavailable++; continue; }
    if (isInactive(employee)) continue;
    zeroExamined++;
    const gross = grossOf(row);
    const net = netOf(row);
    if (gross == null || net == null) { zeroUnavailable++; continue; }
    if (gross === 0 || net === 0) {
      const finding = makeFinding({ type: 'zero_salary', severity: 'warning', row, employee,
        explanation: gross === 0
          ? 'An active employee has zero gross earnings in the selected payroll period; verify eligibility or an approved unpaid period.'
          : 'An active employee has positive gross earnings but zero net payout; review deductions and any approved offset.',
        details: { gross_earnings: gross, deductions: money(row.deduction), net_payout: net },
      });
      zeroFindings.push(finding); findings.push(finding);
    }
  }
  checks.push(result('zero_salary', zeroExamined, payroll.length === 0 || zeroExamined === 0 || zeroUnavailable > 0
    ? 'unable_to_validate' : (zeroFindings.length ? 'warning' : 'passed'),
  payroll.length === 0 ? 'No payroll records are available for this period.' : 'Active employees in the payroll period were checked for zero gross or net payout; no zero is silently treated as valid.', zeroFindings));

  const completedCount = checks.filter((check) => ['passed', 'warning', 'failed'].includes(check.status)).length;
  const allComplete = checks.every((check) => check.status === 'passed');
  const overallStatus = payroll.length === 0 ? 'no_records'
    : checks.some((check) => check.status === 'failed') ? 'failed'
      : checks.some((check) => check.status === 'unable_to_validate') ? 'unable_to_validate'
        : checks.some((check) => check.status === 'warning') ? 'needs_review'
          : allComplete ? 'passed' : 'unable_to_validate';
  const riskLevel = findings.some((finding) => finding.severity === 'critical') ? 'critical'
    : findings.length ? 'warning' : (overallStatus === 'passed' ? 'low' : 'warning');
  const isFuturePeriod = Number.isInteger(period.month) && Number.isInteger(period.year)
    && (period.year > now.getFullYear() || (period.year === now.getFullYear() && period.month > now.getMonth() + 1));
  return {
    checks, findings, recordCount: payroll.length, checksExecuted: completedCount,
    totalAnomalies: findings.length, overallStatus, riskLevel, isFuturePeriod,
  };
}

module.exports = { CHECKS, analyzePayroll, grossOf, netOf };
