const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadAttendanceSummary, resolveAttendanceSummaryScope } = require('../services/aiAttendanceSummary');
const { canUseAiFastPath } = require('../services/aiMetricAccess');
const { pool } = require('../db');
const AIDataService = require('../services/aiDataService');

test('company attendance aggregates follow the existing owner, admin, HR, and employee tool permissions', async () => {
  const calls = [];
  const dataService = {
    async getCompanyAttendanceSummary(input) { calls.push(['company', input]); return { total: 4 }; },
  };

  for (const role of ['owner', 'admin', 'hr', 'employee']) {
    const result = await loadAttendanceSummary({ role, companyId: 'company-a', dataService });
    assert.deepEqual(result, { scope: 'company', summary: { total: 4 } });
  }
  assert.deepEqual(calls, [
    ['company', { companyId: 'company-a' }],
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

test('AI fast paths preserve the role permissions of their existing tools', () => {
  assert.equal(canUseAiFastPath('jobs', 'owner'), true);
  assert.equal(canUseAiFastPath('jobs', 'employee'), true);
  assert.equal(canUseAiFastPath('jobs', 'customer'), false);
  assert.equal(canUseAiFastPath('payroll', 'hr'), true);
  assert.equal(canUseAiFastPath('payroll', 'employee'), false);
  assert.equal(canUseAiFastPath('inventory', 'employee'), true);
  assert.equal(canUseAiFastPath('inventory', 'customer'), false);
  assert.equal(canUseAiFastPath('financial', 'owner'), true);
  assert.equal(canUseAiFastPath('financial', 'admin'), true);
  assert.equal(canUseAiFastPath('financial', 'hr'), false);

  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.routes.js'), 'utf8');
  assert.equal((route.match(/canUseAiFastPath\("(?:jobs|payroll|inventory|financial)", role\)/g) || []).length, 4);
  assert.equal((route.match(/getOwnerDashboardSummary\(\{ companyId \}\)/g) || []).length, 4);
  assert.match(route, /payrollSummary\.leaves\?\.pending_requests \|\| 0/);
  assert.match(route, /ownerSummary\.invoices\?\.pending_count \|\| 0/);
  assert.match(route, /getHrDashboardSummary\(\{ companyId \}\)/);
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
    assert.match(attendanceQuery.query, /l\.company_id::text = u\.company_id::text/);
  } finally {
    pool.query = originalQuery;
  }
});
