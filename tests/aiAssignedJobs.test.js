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

test('assigned-jobs prompt matcher is employee-only and response contains the real employee jobs destination', () => {
  const { isEmployeeAssignedJobsPrompt, createEmployeeAssignedJobsResponse } = require('../services/employeeAssignedJobsResponse');
  assert.equal(isEmployeeAssignedJobsPrompt('employee', 'Show my assigned jobs'), true);
  assert.equal(isEmployeeAssignedJobsPrompt('owner', 'Show my assigned jobs'), false);
  assert.equal(isEmployeeAssignedJobsPrompt('employee', 'Show active jobs'), false);

  const result = createEmployeeAssignedJobsResponse({ totalCount: 1, jobs: [{ title: 'Assigned job' }] }, 12);
  assert.match(result.text, /Assigned job/);
  assert.deepEqual(result.navigation, { path: '/employee/jobs', label: 'Open Assigned Jobs' });
  assert.equal(result.widget.metrics[0].value, 1);
  assert.equal(result.telemetry.latencyMs, 12);

  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.routes.js'), 'utf8');
  assert.match(route, /isEmployeeAssignedJobsPrompt\(role, promptLower\)/);
  assert.match(route, /getEmployeeAssignedJobs\(\{ userId, companyId, limit: 10 \}\)/);
});

test('model prose cannot invent navigation actions and navigation tool destinations are allowlisted', () => {
  const planner = fs.readFileSync(path.join(__dirname, '..', 'ai', 'planner', 'ReAct.engine.js'), 'utf8');
  const navigation = fs.readFileSync(path.join(__dirname, '..', 'ai', 'plugins', 'navigation.plugin.js'), 'utf8');
  assert.match(planner, /navigation: navigationCommand/);
  assert.doesNotMatch(planner, /parsedPayload\?\.navigation\s*\|\|/);
  assert.match(navigation, /const targetRoute = routeMap\[page\]/);
  assert.match(navigation, /NAVIGATION_TARGET_UNAVAILABLE/);
  assert.doesNotMatch(navigation, /routeMap\[page\]\s*\|\|\s*`\$\{prefix\}\/\$\{page\}`/);
});
