const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadAttendanceSummary, resolveAttendanceSummaryScope } = require('../services/aiAttendanceSummary');
const { canUseAiFastPath } = require('../services/aiMetricAccess');
const { pool } = require('../db');
const AIDataService = require('../services/aiDataService');

test('company attendance aggregates are limited to owner, admin, and HR roles', async () => {
  const calls = [];
  const dataService = {
    async getCompanyAttendanceSummary(input) { calls.push(['company', input]); return { total: 4 }; },
  };

  for (const role of ['owner', 'admin', 'hr']) {
    const result = await loadAttendanceSummary({ role, companyId: 'company-a', dataService });
    assert.deepEqual(result, { scope: 'company', summary: { total: 4 } });
  }
  assert.deepEqual(calls, [
    ['company', { companyId: 'company-a' }],
    ['company', { companyId: 'company-a' }],
    ['company', { companyId: 'company-a' }],
  ]);
});

test('customers, superadmins, and missing company/user contexts cannot load attendance data', async () => {
  let calls = 0;
  const dataService = {
    async getCompanyAttendanceSummary() { calls += 1; return {}; },
  };

  assert.equal(resolveAttendanceSummaryScope('customer'), null);
  assert.equal(resolveAttendanceSummaryScope('super_admin'), null);
  assert.equal(await loadAttendanceSummary({ role: 'customer', companyId: 'company-a', dataService }), null);
  assert.equal(await loadAttendanceSummary({ role: 'super_admin', companyId: 'company-a', dataService }), null);
  assert.equal(await loadAttendanceSummary({ role: 'owner', dataService }), null);
  assert.equal(calls, 0);
});

test('company-summary fast paths enforce the approved role boundaries', () => {
  assert.equal(canUseAiFastPath('jobs', 'owner'), true);
  assert.equal(canUseAiFastPath('jobs', 'employee'), false);
  assert.equal(canUseAiFastPath('jobs', 'customer'), false);
  assert.equal(canUseAiFastPath('payroll', 'hr'), false);
  assert.equal(canUseAiFastPath('payroll', 'admin'), true);
  assert.equal(canUseAiFastPath('payroll', 'employee'), false);
  assert.equal(canUseAiFastPath('inventory', 'employee'), false);
  assert.equal(canUseAiFastPath('inventory', 'customer'), false);
  assert.equal(canUseAiFastPath('financial', 'owner'), true);
  assert.equal(canUseAiFastPath('financial', 'admin'), true);
  assert.equal(canUseAiFastPath('financial', 'hr'), false);

  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.routes.js'), 'utf8');
  assert.match(route, /classifyAiFastPathIntent\(cleanMessage, role\)/);
  assert.match(route, /authorizeAiFastPath\(/);
  assert.match(route, /fastPathAuthorization\.allowed/);
  assert.match(route, /getCompanyJobStatusCounts\(\{ companyId \}\)/);
  assert.match(route, /getCompanyLowStockCount\(\{ companyId \}\)/);
  assert.match(route, /getCompanyInvoiceSummary\(\{ companyId \}\)/);
  assert.match(route, /getPendingLeaveCount\(/);
  assert.equal((route.match(/getOwnerDashboardSummary\(\{ companyId \}\)/g) || []).length, 1);
  assert.match(route, /payrollSummary\.leaves\?\.pending_requests \|\| 0/);
  assert.match(route, /getHrDashboardSummary\(\{ companyId \}\)/);
});

test('employee personal attendance summary is scoped by trusted user and company identity', async () => {
  const originalQuery = pool.query;
  let captured;
  pool.query = async (sql, params = []) => {
    const query = String(sql);
    if (query.includes('FROM company_settings')) return { rows: [] };
    captured = { query, params };
    return { rows: [{ check_in_time: '09:00', status: 'present', is_late: false, is_on_leave: false }] };
  };
  try {
    const summary = await AIDataService.getEmployeePersonalAttendanceSummary({ userId: 'employee-a', companyId: 'company-a' });
    assert.deepEqual(summary, { total: 1, present: 1, absent: 0, late: 0, on_leave: 0 });
    assert.deepEqual(captured.params.slice(0, 2), ['employee-a', 'company-a']);
    assert.match(captured.query, /u\.id::text = \$1/);
    assert.match(captured.query, /u\.company_id::text = \$2/);
    assert.match(captured.query, /u\.role = 'employee'/);
    assert.match(captured.query, /l\.company_id::text = u\.company_id::text/);
  } finally {
    pool.query = originalQuery;
  }
});

test('common AI summary queries stay narrow and tenant-scoped', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, params = []) => {
    const query = String(sql);
    calls.push({ query, params });
    if (query.includes('FROM jobs') && query.includes('GROUP BY')) {
      return { rows: [{ status: 'completed', count: 3 }, { status: 'in_progress', count: 2 }] };
    }
    if (query.includes('FROM jobs')) return { rows: [{ active_count: 2 }] };
    if (query.includes('FROM inventory')) return { rows: [{ low_stock_count: 1 }] };
    if (query.includes('FROM invoices')) return { rows: [{ total_invoices: 4, pending_count: 2, pending_amount: 120, overdue_count: 1 }] };
    if (query.includes('FROM payments')) return { rows: [{ today_revenue: 10, month_revenue: 20 }] };
    if (query.includes('FROM leave_requests') && query.includes('user_id::text = $2')) return { rows: [{ pending_count: 1 }] };
    if (query.includes('FROM leave_requests')) return { rows: [{ pending_count: 5 }] };
    throw new Error(`Unexpected SQL in test: ${query}`);
  };

  try {
    assert.deepEqual(await AIDataService.getCompanyJobStatusCounts({ companyId: 'company-a' }), { completed: 3, in_progress: 2 });
    assert.equal(await AIDataService.getEmployeeActiveJobCount({ userId: 'employee-7', companyId: 'company-a' }), 2);
    assert.equal(await AIDataService.getCompanyLowStockCount({ companyId: 'company-a' }), 1);
    assert.deepEqual(await AIDataService.getCompanyInvoiceSummary({ companyId: 'company-a' }), {
      total: 4, pending: 2, pendingAmount: 120, overdue: 1, todayRevenue: 10, monthRevenue: 20,
    });
    assert.equal(await AIDataService.getPendingLeaveCount({ companyId: 'company-a' }), 5);
    assert.equal(await AIDataService.getPendingLeaveCount({ companyId: 'company-a', userId: 'employee-7', personal: true }), 1);
    assert.ok(calls.every(({ params }) => params.includes('company-a')));
    assert.match(calls.find(({ query }) => query.includes('user_id::text = $2')).query, /company_id::text = \$1/);
    const employeeJobQuery = calls.find(({ query }) => query.includes('assigned_employee_id'));
    assert.match(employeeJobQuery.query, /company_id::text = \$2/);
    assert.match(employeeJobQuery.query, /assigned_to::text = \$1/);
    assert.doesNotMatch(employeeJobQuery.query, /\bemployee_id\b/);
  } finally {
    pool.query = originalQuery;
  }
});

test('company attendance counts exclude inactive users and distinguish approved leave from absence', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, params = []) => {
    const query = String(sql);
    calls.push({ query, params });
    if (query.includes('FROM company_settings')) return { rows: [] };
    if (query.includes('LEFT JOIN attendance a')) {
      return { rows: [
        { check_in_time: '09:00', status: 'late', is_late: true, is_on_leave: false },
        { check_in_time: null, status: null, is_late: false, is_on_leave: false },
        { check_in_time: null, status: null, is_late: false, is_on_leave: true },
        { check_in_time: null, status: 'half_day', is_late: false, is_on_leave: false },
      ] };
    }
    throw new Error(`Unexpected SQL in test: ${query}`);
  };

  try {
    const summary = await AIDataService.getCompanyAttendanceSummary({ companyId: 'company-a' });
    const attendanceQuery = calls.find(({ query }) => query.includes('LEFT JOIN attendance a'));
    assert.deepEqual(summary, { total: 4, present: 2, absent: 1, late: 1, on_leave: 1 });
    assert.equal(attendanceQuery.params[0], 'company-a');
    assert.match(attendanceQuery.query, /u\.company_id::text = \$1/);
    assert.match(attendanceQuery.query, /u\.is_active = TRUE/);
    assert.match(attendanceQuery.query, /u\.role = 'employee'/);
    assert.match(attendanceQuery.query, /COALESCE\(NULLIF\(to_jsonb\(u\)->>'status', ''\), 'active'\) <> 'suspended'/);
    assert.doesNotMatch(attendanceQuery.query, /u\.status/);
    assert.match(attendanceQuery.query, /l\.company_id::text = u\.company_id::text/);
  } finally {
    pool.query = originalQuery;
  }
});

test('owner AI dashboard summary supports databases without the optional users.status column', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, params = []) => {
    const query = String(sql);
    calls.push({ query, params });
    if (query.includes('FROM company_settings')) return { rows: [] };
    if (query.includes('FROM jobs')) return { rows: [] };
    if (query.includes('FROM payments')) return { rows: [{ today_revenue: 0, month_revenue: 0 }] };
    if (query.includes('FROM invoices')) return { rows: [{ total_invoices: 0, pending_count: 0, pending_amount: 0, overdue_count: 0 }] };
    if (query.includes('FROM users u')) return { rows: [] };
    if (query.includes('FROM inventory')) return { rows: [] };
    if (query.includes('FROM leave_requests') && query.includes("status = 'pending'")) return { rows: [{ pending_leaves: 0 }] };
    if (query.includes('FROM leave_requests') && query.includes("status = 'approved'")) return { rows: [{ on_leave_count: 0 }] };
    throw new Error(`Unexpected SQL in test: ${query}`);
  };

  try {
    await AIDataService.getOwnerDashboardSummary({ companyId: 'company-a' });
    const attendanceQuery = calls.find(({ query }) => query.includes('FROM users u'));
    assert.ok(attendanceQuery);
    assert.match(attendanceQuery.query, /COALESCE\(NULLIF\(to_jsonb\(u\)->>'status', ''\), 'active'\) <> 'suspended'/);
    assert.doesNotMatch(attendanceQuery.query, /u\.status/);
    assert.match(attendanceQuery.query, /u\.company_id::text = \$1::text/);
    assert.equal(attendanceQuery.params[0], 'company-a');
  } finally {
    pool.query = originalQuery;
  }
});
