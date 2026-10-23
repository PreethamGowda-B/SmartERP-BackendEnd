'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../db');
const AIDataService = require('../services/aiDataService');
const { getAiErrorResponse } = require('../utils/aiErrorResponse');

test('employee assigned-jobs query uses only tracked assignment columns and both user and company scope', async () => {
  const originalQuery = pool.query;
  let captured;
  pool.query = async (sql, params) => {
    captured = { sql: String(sql), params };
    return { rows: [{ id: 'job-a', title: 'Assigned job', status: 'open', total_count: 1 }] };
  };
  try {
    const result = await AIDataService.getEmployeeAssignedJobs({
      userId: 'employee-a', companyId: 'company-a', limit: 10,
    });
    assert.equal(result.totalCount, 1);
    assert.equal(result.jobs[0].id, 'job-a');
    assert.deepEqual(captured.params, ['employee-a', 'company-a', 10]);
    assert.match(captured.sql, /j\.company_id::text = \$2/);
    assert.match(captured.sql, /j\.assigned_employee_id::text = \$1 OR j\.assigned_to::text = \$1/);
    assert.doesNotMatch(captured.sql, /\bemployee_id\b/);
    assert.doesNotMatch(captured.sql, /\bj\.stage\b/);
  } finally {
    pool.query = originalQuery;
  }
});

test('employee AI get_jobs tool returns personal assignments while owner tool remains company-scoped', async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [] };
  };
  try {
    const JobsPlugin = require('../ai/plugins/jobs.plugin');
    const jobsPlugin = new JobsPlugin();
    await jobsPlugin.tools.get_jobs.execute({}, {
      planTier: 'professional',
      user: { id: 'employee-a', role: 'employee', companyId: 'company-a' },
    });
    assert.match(calls[0].sql, /j\.company_id::text = \$2/);
    assert.match(calls[0].sql, /j\.assigned_to::text = \$1/);
    calls.length = 0;
    await jobsPlugin.tools.get_delayed_jobs.execute({}, {
      user: { id: 'employee-a', role: 'employee', companyId: 'company-a' },
    });
    assert.match(calls[0].sql, /j\.company_id::text = \$2/);
    assert.match(calls[0].sql, /j\.assigned_to::text = \$1/);
    calls.length = 0;
    await jobsPlugin.tools.get_jobs.execute({}, {
      planTier: 'professional',
      user: { id: 'owner-a', role: 'owner', companyId: 'company-a' },
    });
    assert.match(calls[0].sql, /WHERE company_id::text = \$1/);
    assert.doesNotMatch(calls[0].sql, /assigned_to::text = \$1/);
  } finally {
    pool.query = originalQuery;
  }
});

test('assigned-job service database failures remain unavailable rather than becoming empty results', async () => {
  const originalQuery = pool.query;
  const databaseError = Object.assign(new Error('synthetic missing column'), { code: '42703' });
  pool.query = async () => { throw databaseError; };
  try {
    await assert.rejects(
      AIDataService.getEmployeeAssignedJobs({ userId: 'employee-a', companyId: 'company-a' }),
      (error) => error === databaseError
    );
    assert.equal(getAiErrorResponse(databaseError).status, 503);
    assert.equal(getAiErrorResponse(databaseError).body.code, 'AI_DATA_UNAVAILABLE');
  } finally {
    pool.query = originalQuery;
  }
});

test('job tool limits are bounded and passed as SQL parameters', async () => {
  const originalQuery = pool.query;
  let captured;
  pool.query = async (sql, params) => {
    captured = { sql: String(sql), params };
    return { rows: [] };
  };
  try {
    const JobService = require('../services/jobService');
    await JobService.getJobs({ companyId: 'company-a', limit: '1; DROP TABLE jobs' });
    assert.match(captured.sql, /LIMIT \$2/);
    assert.deepEqual(captured.params, ['company-a', 50]);
    await JobService.getJobs({ companyId: 'company-a', status: 'open', limit: 500 });
    assert.match(captured.sql, /LIMIT \$3/);
    assert.deepEqual(captured.params, ['company-a', 'open', 100]);
  } finally {
    pool.query = originalQuery;
  }
});

test('AI job creation persists the authenticated actor UUID rather than a text label', async () => {
  const originalQuery = pool.query;
  let captured;
  pool.query = async (sql, params) => {
    captured = { sql: String(sql), params };
    return { rows: [{ id: 'job-new', title: 'New job' }] };
  };
  try {
    const JobService = require('../services/jobService');
    await assert.rejects(JobService.createJob({ companyId: 'company-a', title: 'Missing actor' }), /actor ID/);
    await JobService.createJob({ companyId: 'company-a', createdBy: 'owner-a', title: 'Created job' });
    assert.match(captured.sql, /created_by/);
    assert.match(captured.sql, /\$6/);
    assert.equal(captured.params[5], 'owner-a');
    assert.doesNotMatch(captured.sql, /'AI Copilot'/);
  } finally {
    pool.query = originalQuery;
  }
});

test('assigned-jobs prompt matcher is employee-only and response contains the real employee jobs destination', () => {
  const { isEmployeeAssignedJobsPrompt, createEmployeeAssignedJobsResponse } = require('../services/employeeAssignedJobsResponse');
  assert.equal(isEmployeeAssignedJobsPrompt('employee', 'Show my assigned jobs'), true);
  assert.equal(isEmployeeAssignedJobsPrompt('employee', 'Show jobs assigned to me'), true);
  assert.equal(isEmployeeAssignedJobsPrompt('owner', 'Show my assigned jobs'), false);
  assert.equal(isEmployeeAssignedJobsPrompt('employee', 'Show active jobs'), false);
  assert.equal(isEmployeeAssignedJobsPrompt('employee', 'Show assigned jobs'), false);

  const result = createEmployeeAssignedJobsResponse({ totalCount: 1, jobs: [{ title: 'Assigned job' }] }, 12);
  assert.match(result.text, /Assigned job/);
  assert.deepEqual(result.navigation, { path: '/employee/jobs', label: 'Open Assigned Jobs' });
  assert.equal(result.widget.metrics[0].value, 1);
  assert.equal(result.telemetry.latencyMs, 12);

  const empty = createEmployeeAssignedJobsResponse({ totalCount: 0, jobs: [] });
  assert.match(empty.text, /no directly assigned jobs/i);
  assert.equal(empty.widget.metrics[0].value, 0);

  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.routes.js'), 'utf8');
  assert.match(route, /isEmployeeAssignedJobsPrompt\(role, promptLower\)/);
  assert.match(route, /getEmployeeAssignedJobs\(\{ userId, companyId, limit: 10 \}\)/);
});

test('model prose cannot invent navigation actions and navigation tool destinations are allowlisted', () => {
  const planner = fs.readFileSync(path.join(__dirname, '..', 'ai', 'planner', 'ReAct.engine.js'), 'utf8');
  const navigation = fs.readFileSync(path.join(__dirname, '..', 'ai', 'plugins', 'navigation.plugin.js'), 'utf8');
  assert.match(planner, /navigation: navigationCommand/);
  assert.doesNotMatch(planner, /parsedPayload\?\.navigation\s*\|\|/);
  assert.match(planner, /proposedWidget\?\.type === "ACTION_CONFIRMATION"[\s\S]*?actionConfirmation/);
  assert.match(planner, /confidenceScore: undefined/);
  assert.match(navigation, /const targetRoute = routeMap\[page\]/);
  assert.match(navigation, /NAVIGATION_TARGET_UNAVAILABLE/);
  assert.doesNotMatch(navigation, /routeMap\[page\]\s*\|\|\s*`\$\{prefix\}\/\$\{page\}`/);
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.routes.js'), 'utf8');
  assert.match(routes, /confidenceScore: undefined/);
  assert.match(routes, /diagnostic\.cause = \{ code: error\.cause\.code \}/);
});

test('registered navigation action resolves only supported destinations', async () => {
  const NavigationPlugin = require('../ai/plugins/navigation.plugin');
  const navigation = new NavigationPlugin();
  const valid = await navigation.tools.navigate_to_route.execute({ targetPage: 'jobs' }, { user: { role: 'employee' } });
  assert.deepEqual(valid, { action: 'NAVIGATE', path: '/employee/jobs', label: 'Opening jobs module...' });
  const invalid = await navigation.tools.navigate_to_route.execute({ targetPage: '/employee/jobs?company=other' }, { user: { role: 'employee' } });
  assert.equal(invalid.action, undefined);
  assert.equal(invalid.error, 'NAVIGATION_TARGET_UNAVAILABLE');
});

test('specialist scopes restrict tool access at advertisement and execution while general remains role/plan filtered', () => {
  const { isPluginAllowedForAiScope } = require('../services/aiPluginScope');
  assert.equal(isPluginAllowedForAiScope('inventory', 'InventoryPlugin'), true);
  assert.equal(isPluginAllowedForAiScope('inventory', 'FinancialPlugin'), false);
  assert.equal(isPluginAllowedForAiScope('finance', 'FinancialPlugin'), true);
  assert.equal(isPluginAllowedForAiScope('security', 'SecurityPlugin'), true);
  assert.equal(isPluginAllowedForAiScope('security', 'JobsPlugin'), false);
  assert.equal(isPluginAllowedForAiScope('general', 'SecurityPlugin'), false);
  assert.equal(isPluginAllowedForAiScope('unknown-specialist', 'JobsPlugin'), false);

  const registry = fs.readFileSync(path.join(__dirname, '..', 'ai', 'plugins', 'index.js'), 'utf8');
  const planner = fs.readFileSync(path.join(__dirname, '..', 'ai', 'planner', 'ReAct.engine.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.routes.js'), 'utf8');
  assert.match(registry, /isPluginAllowedForAiScope\(context\?\.aiModelScope, pluginName\)/);
  assert.match(registry, /isPluginAllowedForAiScope\(context\?\.aiModelScope, targetPlugin\.constructor\.name\)/);
  assert.match(planner, /aiModelScope: modelScope/);
  assert.match(route, /modelScope: scope/);
});

test('employee role cannot use AI directory tools that return other employees or customer contact records', () => {
  const EmployeePlugin = require('../ai/plugins/employee.plugin');
  const CustomerPlugin = require('../ai/plugins/customer.plugin');
  const employeeDirectory = new EmployeePlugin().tools.get_employees;
  const customerDirectory = new CustomerPlugin().tools.get_customers;
  assert.deepEqual(employeeDirectory.allowedRoles, ['owner', 'hr', 'admin']);
  assert.deepEqual(customerDirectory.allowedRoles, ['owner', 'hr', 'admin']);
});
