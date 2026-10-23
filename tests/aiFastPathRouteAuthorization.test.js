'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const redisModulePath = require.resolve('../utils/redis');
const originalRedisModule = require.cache[redisModulePath];
require.cache[redisModulePath] = {
  id: redisModulePath, filename: redisModulePath, loaded: true, exports: { redisClient: null },
};
const router = require('../routes/ai.routes');
const AIDataService = require('../services/aiDataService');
const ReActEngine = require('../ai/planner/ReAct.engine');

function requestJson(port, path, body, role = 'owner', planId = 3, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(options.missingRole ? {} : { 'x-test-role': role }),
        'x-test-plan': String(planId),
        ...(options.missingCompany ? {} : { 'x-test-company': 'company-authenticated' }),
        ...(options.missingUser ? {} : { 'x-test-user': `${role}-authenticated` }),
        ...(options.aiFeature === false ? { 'x-test-ai': 'false' } : {}),
      },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test('agent aliases enforce fast-path authorization before resolvers and provider calls', async (t) => {
  const agentLayer = router.stack.find((layer) => layer.route?.path === '/agent');
  assert.ok(agentLayer, 'agent route must be registered');
  const handlers = agentLayer.route.stack.map((layer) => layer.handle);
  const original = {
    getEmployeeAssignedJobs: AIDataService.getEmployeeAssignedJobs,
    getEmployeePersonalAttendanceSummary: AIDataService.getEmployeePersonalAttendanceSummary,
    getCompanyJobStatusCounts: AIDataService.getCompanyJobStatusCounts,
    getCompanyAttendanceSummary: AIDataService.getCompanyAttendanceSummary,
    getCompanyLowStockCount: AIDataService.getCompanyLowStockCount,
    getPendingLeaveCount: AIDataService.getPendingLeaveCount,
    run: ReActEngine.run,
  };
  const calls = [];
  let providerCalls = 0;
  let lowStockFailure = false;

  agentLayer.route.stack[0].handle = (req, _res, next) => {
    req.user = {
      role: req.get('x-test-role'),
      companyId: req.get('x-test-company'),
      userId: req.get('x-test-user'),
      name: 'Test User',
    };
    next();
  };
  agentLayer.route.stack[1].handle = (req, _res, next) => {
    req.plan = { id: Number(req.get('x-test-plan')), features: { ai_assistant: req.get('x-test-ai') !== 'false' } };
    next();
  };
  agentLayer.route.stack[3].handle = (req, _res, next) => {
    req.sanitizedAiMessage = req.body.message;
    next();
  };

  AIDataService.getEmployeeAssignedJobs = async (args) => {
    calls.push(['assigned_jobs', args]);
    return { totalCount: 1, jobs: [{ title: 'Assigned work' }] };
  };
  AIDataService.getEmployeePersonalAttendanceSummary = async (args) => {
    calls.push(['personal_attendance', args]);
    return { total: 1, present: 1, absent: 0, late: 0, on_leave: 0 };
  };
  AIDataService.getCompanyJobStatusCounts = async (args) => {
    calls.push(['company_jobs', args]);
    return { completed: 2, in_progress: 1 };
  };
  AIDataService.getCompanyAttendanceSummary = async (args) => {
    calls.push(['company_attendance', args]);
    return { total: 1, present: 1, absent: 0, late: 0, on_leave: 0 };
  };
  AIDataService.getCompanyLowStockCount = async (args) => {
    calls.push(['low_stock', args]);
    if (lowStockFailure) throw new Error('mocked SQL details must stay private');
    return 0;
  };
  AIDataService.getPendingLeaveCount = async (args) => {
    calls.push(['pending_leave', args]);
    return 1;
  };
  ReActEngine.run = async () => { providerCalls += 1; return { text: 'mock provider response' }; };

  const app = express();
  app.use(express.json());
  app.use('/api/ai', router);
  app.use('/api/v1/ai', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    agentLayer.route.stack.forEach((layer, index) => { layer.handle = handlers[index]; });
    Object.assign(AIDataService, {
      getEmployeeAssignedJobs: original.getEmployeeAssignedJobs,
      getEmployeePersonalAttendanceSummary: original.getEmployeePersonalAttendanceSummary,
      getCompanyJobStatusCounts: original.getCompanyJobStatusCounts,
      getCompanyAttendanceSummary: original.getCompanyAttendanceSummary,
      getCompanyLowStockCount: original.getCompanyLowStockCount,
      getPendingLeaveCount: original.getPendingLeaveCount,
    });
    ReActEngine.run = original.run;
  });
  const port = server.address().port;
  const protectedCalls = () => calls.length;

  for (const path of ['/api/ai/agent', '/api/v1/ai/agent']) {
    const deniedBefore = protectedCalls();
    const denied = await requestJson(port, path, { message: 'How many jobs are completed?', companyId: 'forged-company' }, 'employee', 3);
    assert.equal(denied.status, 403);
    assert.equal(protectedCalls(), deniedBefore);
    assert.equal(providerCalls, 0);

    const missingRole = await requestJson(port, path, { message: 'How many jobs are completed?' }, 'owner', 3, { missingRole: true });
    assert.equal(missingRole.status, 403);
    assert.equal(protectedCalls(), deniedBefore);
    assert.equal(providerCalls, 0);

    const missingCompany = await requestJson(port, path, { message: 'How many jobs are completed?' }, 'owner', 3, { missingCompany: true });
    assert.equal(missingCompany.status, 403);
    assert.equal(protectedCalls(), deniedBefore);
    assert.equal(providerCalls, 0);

    const missingActor = await requestJson(port, path, { message: 'How many jobs are completed?' }, 'owner', 3, { missingUser: true });
    assert.equal(missingActor.status, 403);
    assert.equal(protectedCalls(), deniedBefore);
    assert.equal(providerCalls, 0);

    const missingUser = await requestJson(port, path, { message: 'Show my attendance summary', modelScopes: ['attendance'] }, 'employee', 3, { missingUser: true });
    assert.equal(missingUser.status, 403);
    assert.equal(protectedCalls(), deniedBefore);
    assert.equal(providerCalls, 0);

    const generalFeatureDisabled = await requestJson(port, path, { message: 'How many jobs are completed?' }, 'owner', 3, { aiFeature: false });
    assert.equal(generalFeatureDisabled.status, 403);
    assert.equal(protectedCalls(), deniedBefore);
    assert.equal(providerCalls, 0);

    const attendanceDenied = await requestJson(port, path, { message: 'Who is present today?' }, 'employee', 3);
    assert.equal(attendanceDenied.status, 403);
    assert.equal(protectedCalls(), deniedBefore);
    assert.equal(providerCalls, 0);

    const inventoryDenied = await requestJson(port, path, { message: 'Audit low stock inventory' }, 'employee', 3);
    assert.equal(inventoryDenied.status, 403);
    assert.equal(protectedCalls(), deniedBefore);
    assert.equal(providerCalls, 0);

    const otherEmployeeDenied = await requestJson(port, path, { message: "Show John's attendance" }, 'employee', 3);
    assert.equal(otherEmployeeDenied.status, 403);
    assert.equal(protectedCalls(), deniedBefore);
    assert.equal(providerCalls, 0);

    const unknownProtectedDenied = await requestJson(port, path, { message: 'Show employee records from another module' }, 'employee', 3);
    assert.equal(unknownProtectedDenied.status, 403);
    assert.equal(protectedCalls(), deniedBefore);
    assert.equal(providerCalls, 0);
  }

  const ownerStarter = await requestJson(port, '/api/v1/ai/agent', { message: 'How many jobs are completed?', companyId: 'forged-company' }, 'owner', 1);
  assert.equal(ownerStarter.status, 200);
  assert.match(ownerStarter.body.text, /2.*3/);
  assert.deepEqual(calls.at(-1), ['company_jobs', { companyId: 'company-authenticated' }]);

  const ownerStarterAlias = await requestJson(port, '/api/ai/agent', { message: 'How many jobs are completed?' }, 'owner', 1);
  assert.equal(ownerStarterAlias.status, ownerStarter.status);
  assert.equal(ownerStarterAlias.body.text, ownerStarter.body.text);

  const assigned = await requestJson(port, '/api/ai/agent', { message: 'Show my assigned jobs', companyId: 'forged-company' }, 'employee', 1);
  assert.equal(assigned.status, 200);
  assert.deepEqual(calls.at(-1), ['assigned_jobs', { userId: 'employee-authenticated', companyId: 'company-authenticated', limit: 10 }]);

  const personal = await requestJson(port, '/api/ai/agent', {
    message: 'Show my attendance summary', modelScopes: ['attendance'], autoMode: false,
    clientContext: { companyId: 'forged-company', employeeId: 'other-employee' },
  }, 'employee', 2);
  assert.equal(personal.status, 200);
  assert.match(personal.body.text, /Your attendance summary/);
  assert.deepEqual(calls.at(-1), ['personal_attendance', { userId: 'employee-authenticated', companyId: 'company-authenticated' }]);

  const ownLeave = await requestJson(port, '/api/ai/agent', { message: 'Show my pending leave requests' }, 'employee', 1);
  assert.equal(ownLeave.status, 200);
  assert.deepEqual(calls.at(-1), ['pending_leave', {
    companyId: 'company-authenticated', userId: 'employee-authenticated', personal: true,
  }]);

  const mismatchedScope = await requestJson(port, '/api/ai/agent', {
    message: 'Audit low stock inventory', modelScopes: ['finance'], autoMode: false,
  }, 'owner', 3);
  assert.equal(mismatchedScope.status, 403);
  assert.equal(mismatchedScope.body.code, 'AI_MODEL_INTENT_MISMATCH');
  assert.equal(providerCalls, 0);

  const ambiguousFinanceGst = await requestJson(port, '/api/ai/agent', { message: 'Show my GST invoice' }, 'owner', 3);
  assert.equal(ambiguousFinanceGst.status, 200);
  assert.match(ambiguousFinanceGst.body.text, /finance summary.*GST summary.*combined/i);
  assert.equal(providerCalls, 0);

  const invalidScope = await requestJson(port, '/api/ai/agent', { message: 'Show attendance summary', modelScopes: ['finance'], autoMode: false }, 'owner', 3);
  assert.equal(invalidScope.status, 403);
  assert.equal(invalidScope.body.code, 'AI_MODEL_INTENT_MISMATCH');
  assert.equal(calls.filter(([key]) => key === 'company_attendance').length, 0);

  lowStockFailure = true;
  const inventoryFailure = await requestJson(port, '/api/ai/agent', { message: 'Audit low stock inventory' }, 'owner', 3);
  lowStockFailure = false;
  assert.notEqual(inventoryFailure.status, 200);
  assert.doesNotMatch(JSON.stringify(inventoryFailure.body), /mocked SQL details/);
  assert.equal(providerCalls, 0);
});

test.after(() => {
  if (originalRedisModule) require.cache[redisModulePath] = originalRedisModule;
  else delete require.cache[redisModulePath];
});
