'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CustomerPlugin = require('../ai/plugins/customer.plugin');
const EmployeePlugin = require('../ai/plugins/employee.plugin');
const JobsPlugin = require('../ai/plugins/jobs.plugin');
const PayrollPlugin = require('../ai/plugins/payroll.plugin');
const CustomerService = require('../services/customerService');
const EmployeeService = require('../services/employeeService');
const JobService = require('../services/jobService');
const PayrollService = require('../services/payrollService');

test('every registered destructive AI write passes its transaction queryable into the service', async (t) => {
  const cases = [
    [new CustomerPlugin(), 'create_customer', CustomerService, 'createCustomer', { name: 'Test' }],
    [new EmployeePlugin(), 'create_employee', EmployeeService, 'createEmployee', { name: 'Test', email: 'test@example.test' }],
    [new JobsPlugin(), 'create_job', JobService, 'createJob', { title: 'Test' }],
    [new PayrollPlugin(), 'calculate_payroll', PayrollService, 'calculatePayroll', { month: '1', year: '2026' }],
  ];
  const client = { query: async () => ({ rows: [] }) };
  const originals = cases.map(([, , service, method]) => [service, method, service[method]]);
  t.after(() => originals.forEach(([service, method, original]) => { service[method] = original; }));

  for (const [plugin, toolName, service, method, params] of cases) {
    const tool = plugin.tools[toolName];
    assert.equal(tool.isDestructive, true);
    assert.equal(tool.requiresTransactionalAudit, true);
    service[method] = async (args) => {
      assert.equal(args.queryable, client, `${toolName} receives the active transaction client`);
      return { success: true };
    };
    await tool.execute(params, { user: { id: 'user-1', companyId: 'company-1', role: 'owner' }, dbClient: client });
  }
});
