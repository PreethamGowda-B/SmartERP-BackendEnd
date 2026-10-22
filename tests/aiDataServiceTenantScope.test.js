const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const AIDataService = require('../services/aiDataService');

test('AI attendance summary queries remain scoped to the authenticated company', async () => {
  const originalQuery = pool.query;
  const calls = [];
  const companyId = 'owner-company-17';
  pool.query = async (sql, params = []) => {
    const query = String(sql);
    calls.push({ query, params });
    if (query.includes('LEFT JOIN attendance a')) {
      return { rows: [{ user_id: 'employee-1', check_in_time: null, status: null, is_late: false }] };
    }
    if (query.includes('FROM payments')) return { rows: [{ today_revenue: 0, month_revenue: 0 }] };
    if (query.includes('FROM invoices')) return { rows: [{ total_invoices: 4, pending_count: 2, pending_amount: 1250, overdue_count: 1 }] };
    if (query.includes('FROM leave_requests') && query.includes('start_date')) return { rows: [{ on_leave_count: 0 }] };
    if (query.includes('FROM leave_requests')) return { rows: [{ pending_leaves: 0 }] };
    return { rows: [] };
  };

  try {
    const summary = await AIDataService.getOwnerDashboardSummary({ companyId });
    const attendanceQuery = calls.find(({ query }) => query.includes('LEFT JOIN attendance a'));
    assert.equal(attendanceQuery.params[0], companyId);
    assert.match(attendanceQuery.query, /a\.company_id::text = u\.company_id::text/);
    assert.match(attendanceQuery.query, /u\.company_id = \$1 OR u\.company_id::text = \$1::text/);
    assert.equal(summary.attendance.total, 1);
    assert.equal(summary.employees.active_count, 1);
    assert.equal(summary.invoices.total, 4);
    assert.equal(summary.invoices.pending_count, 2);
    const invoiceQuery = calls.find(({ query }) => query.includes('FROM invoices'));
    assert.match(invoiceQuery.query, /COUNT\(\*\) FILTER \(WHERE status = 'issued'\) as pending_count/);
    assert.match(attendanceQuery.query, /u\.is_active = TRUE/);
  } finally {
    pool.query = originalQuery;
  }
});

test('AI attendance database errors propagate so the route can return an error instead of false zero counts', async () => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    if (String(sql).includes('LEFT JOIN attendance a')) throw new Error('simulated attendance query failure');
    if (String(sql).includes('company_settings')) return { rows: [] };
    if (String(sql).includes('FROM payments')) return { rows: [{ today_revenue: 0, month_revenue: 0 }] };
    if (String(sql).includes('FROM invoices')) return { rows: [{ total_invoices: 0, pending_amount: 0, overdue_count: 0 }] };
    if (String(sql).includes('FROM leave_requests') && String(sql).includes('start_date')) return { rows: [{ on_leave_count: 0 }] };
    if (String(sql).includes('FROM leave_requests')) return { rows: [{ pending_leaves: 0 }] };
    return { rows: [] };
  };
  try {
    await assert.rejects(AIDataService.getOwnerDashboardSummary({ companyId: 'owner-company-17' }), /simulated attendance query failure/);
  } finally {
    pool.query = originalQuery;
  }
});

test('employee AI dashboard queries explicitly scope every linked record to the authenticated company', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, params = []) => {
    const query = String(sql);
    calls.push({ query, params });
    if (query.includes('FROM company_settings')) return { rows: [] };
    if (query.includes('FROM jobs')) return { rows: [] };
    if (query.includes('FROM attendance')) return { rows: [] };
    if (query.includes('FROM leave_requests')) return { rows: [] };
    if (query.includes('FROM material_requests')) return { rows: [] };
    if (query.includes('FROM users')) return { rows: [] };
    throw new Error(`Unexpected SQL in test: ${query}`);
  };

  try {
    await AIDataService.getEmployeeDashboardSummary({ userId: 'employee-1', companyId: 'company-a' });
    for (const table of ['jobs', 'leave_requests', 'material_requests']) {
      const call = calls.find(({ query }) => query.includes(`FROM ${table}`));
      assert.ok(call, `expected a ${table} query`);
      assert.deepEqual(call.params.slice(0, 2), ['employee-1', 'company-a']);
      assert.match(call.query, /company_id::text = \$2/);
    }
    await AIDataService.getHrDashboardSummary({ companyId: 'company-a' });
    const leaveJoin = calls.find(({ query }) => query.includes('LEFT JOIN users u'));
    assert.match(leaveJoin.query, /l\.company_id::text = u\.company_id::text/);
  } finally {
    pool.query = originalQuery;
  }
});
