'use strict';

process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validatePurchaseOrderPayload,
  createPurchaseOrderHandler,
  createVendorReadHandler,
} = require('../routes/cncVendors');
const { createWarrantyClaimsReadHandler } = require('../routes/warrantyClaims');
const {
  SUPPORTED_AUTOMATION_ACTIONS,
  isSupportedAutomationAction,
  executeAutomationAction,
  evaluateAutomationRules,
} = require('../helpers/evaluateAutomations');
const {
  validateRouteOptimizationRequest,
  handleRouteOptimization,
} = require('../routes/routeOptimization');

function mockResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('purchase-order payload validation requires real fields and a database-safe numeric amount', () => {
  assert.deepEqual(validatePurchaseOrderPayload({
    vendor_name: '  Supplier  ',
    parts_description: '  Replacement spindle  ',
    total_cost: '1250.50',
    job_id: '12',
  }), {
    valid: true,
    value: { vendorName: 'Supplier', partsDescription: 'Replacement spindle', totalCost: 1250.5, jobId: 12 },
  });

  for (const payload of [
    { parts_description: 'Part', total_cost: 1 },
    { vendor_name: 'Supplier', total_cost: 1 },
    { vendor_name: 'Supplier', parts_description: 'Part' },
    { vendor_name: ' ', parts_description: 'Part', total_cost: 1 },
    { vendor_name: 'Supplier', parts_description: 'Part', total_cost: '' },
    { vendor_name: 'Supplier', parts_description: 'Part', total_cost: 'Infinity' },
    { vendor_name: 'Supplier', parts_description: 'Part', total_cost: -1 },
    { vendor_name: 'Supplier', parts_description: 'Part', total_cost: 10000000000 },
    { vendor_name: 'Supplier', parts_description: 'Part', total_cost: 1, job_id: '1.5' },
  ]) {
    assert.equal(validatePurchaseOrderPayload(payload).valid, false);
  }
});

test('purchase-order handler does not write invalid or unaffiliated requests', async () => {
  let calls = 0;
  const handler = createPurchaseOrderHandler(async () => { calls += 1; return { rows: [] }; });
  const invalidResponse = mockResponse();
  await handler({ user: { companyId: 'tenant-a', role: 'owner' }, body: { vendor_name: 'V', parts_description: 'P', total_cost: 'bad' } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(calls, 0);

  const unaffiliatedResponse = mockResponse();
  await handler({ user: { role: 'employee' }, body: { vendor_name: 'V', parts_description: 'P', total_cost: 1 } }, unaffiliatedResponse);
  assert.equal(unaffiliatedResponse.statusCode, 401);
  assert.equal(calls, 0);
});

test('purchase-order handler writes only the reviewed company payload and returns the actual saved row', async () => {
  const calls = [];
  const saved = { id: 44, po_number: 'PO-123456', vendor_name: 'Supplier', parts_description: 'Part', total_cost: '300' };
  const handler = createPurchaseOrderHandler(async (...args) => {
    calls.push(args);
    if (args[0].includes('FROM jobs')) return { rows: [{ id: 5 }] };
    return { rows: [saved] };
  });
  const response = mockResponse();
  await handler({
    user: { companyId: 27, role: 'owner' },
    body: { vendor_name: ' Supplier ', parts_description: ' Part ', total_cost: 300, job_id: 5 },
  }, response);

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.body.purchase_order, saved);
  assert.match(calls[0][0], /FROM jobs.*company_id::text = \$2::text/s);
  assert.deepEqual(calls[0][1], ['5', '27']);
  assert.match(calls[1][0], /INSERT INTO purchase_orders/);
  assert.deepEqual(calls[1][1].slice(0, 1), ['27']);
  assert.deepEqual(calls[1][1].slice(2), ['Supplier', 5, 'Part', 300]);
});

test('purchase-order handler rejects a job from outside the company before inserting', async () => {
  const calls = [];
  const handler = createPurchaseOrderHandler(async (...args) => {
    calls.push(args);
    return { rows: [] };
  });
  const response = mockResponse();
  await handler({
    user: { companyId: 'tenant-a', role: 'owner' },
    body: { vendor_name: 'Supplier', parts_description: 'Part', total_cost: 10, job_id: 8 },
  }, response);

  assert.equal(response.statusCode, 404);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /company_id::text = \$2::text/);
});

test('purchase-order database failures return sanitized errors', async () => {
  const handler = createPurchaseOrderHandler(async () => { throw Object.assign(new Error('private SQL text'), { code: 'XX000' }); });
  const response = mockResponse();
  await handler({ user: { company_id: 'tenant-a', role: 'owner' }, body: { vendor_name: 'V', parts_description: 'P', total_cost: 0 } }, response);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.message, 'Failed to create purchase order.');
  assert.doesNotMatch(JSON.stringify(response.body), /private SQL|XX000/);
});

test('vendor read distinguishes a valid empty result from a database error and retains company scoping', async () => {
  const calls = [];
  const emptyHandler = createVendorReadHandler(async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  });
  const emptyResponse = mockResponse();
  await emptyHandler({ user: { companyId: 'tenant-a', role: 'owner' } }, emptyResponse);
  assert.equal(emptyResponse.statusCode, 200);
  assert.deepEqual(emptyResponse.body, { success: true, vendors: [], purchase_orders: [] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, ['tenant-a']);
  assert.match(calls[1].sql, /company_id::text = \$1::text/);

  const failedHandler = createVendorReadHandler(async () => { throw Object.assign(new Error('sensitive query detail'), { code: 'XX000' }); });
  const failedResponse = mockResponse();
  await failedHandler({ user: { companyId: 'tenant-a', role: 'owner' } }, failedResponse);
  assert.equal(failedResponse.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(failedResponse.body), /sensitive query|XX000/);
});

test('warranty-claim read distinguishes empty results from database failures', async () => {
  const emptyResponse = mockResponse();
  await createWarrantyClaimsReadHandler(async () => ({ rows: [] }))(
    { user: { companyId: 'tenant-a', role: 'owner' } },
    emptyResponse
  );
  assert.equal(emptyResponse.statusCode, 200);
  assert.deepEqual(emptyResponse.body, { success: true, claims: [] });

  const failedResponse = mockResponse();
  await createWarrantyClaimsReadHandler(async () => { throw Object.assign(new Error('private SQL'), { code: 'XX000' }); })(
    { user: { companyId: 'tenant-a', role: 'owner' } },
    failedResponse
  );
  assert.equal(failedResponse.statusCode, 500);
  assert.equal(failedResponse.body.message, 'Failed to load warranty claims.');
  assert.doesNotMatch(JSON.stringify(failedResponse.body), /private SQL|XX000/);
});

test('route optimization rejects invalid requests and reports unavailable instead of fabricated success', () => {
  assert.equal(validateRouteOptimizationRequest({ stops: ['Only one'] }).valid, false);
  assert.equal(validateRouteOptimizationRequest({ stops: ['', 'second'] }).valid, false);
  assert.equal(validateRouteOptimizationRequest({ stops: ['first', 'second'] }).valid, true);

  const invalidResponse = mockResponse();
  handleRouteOptimization({ body: { stops: ['Only one'] } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);

  const unavailableResponse = mockResponse();
  handleRouteOptimization({ body: { stops: ['first', 'second'] } }, unavailableResponse);
  assert.equal(unavailableResponse.statusCode, 501);
  assert.equal(unavailableResponse.body.success, false);
  assert.equal(unavailableResponse.body.code, 'ROUTE_OPTIMIZATION_UNAVAILABLE');
});

test('automation exposes only the implemented tenant-scoped action', async () => {
  assert.deepEqual(SUPPORTED_AUTOMATION_ACTIONS, ['escalate_priority']);
  for (const action of SUPPORTED_AUTOMATION_ACTIONS) assert.equal(isSupportedAutomationAction(action), true);

  let call;
  const success = await executeAutomationAction('escalate_priority', {
    companyId: 'tenant-a',
    jobId: 'job-7',
  }, async (...args) => {
    call = args;
    return { rowCount: 1, rows: [{ id: 'job-7' }] };
  });
  assert.equal(success.success, true);
  assert.match(call[0], /company_id::text = \$2::text/);
  assert.deepEqual(call[1], ['job-7', 'tenant-a']);

  for (const action of ['notify_owner', 'notify_manager', 'auto_po', 'auto_pm', 'reserve_part', 'unknown']) {
    assert.equal(isSupportedAutomationAction(action), false);
    let queryCalls = 0;
    const rejected = await executeAutomationAction(action, { companyId: 'tenant-a' }, async () => { queryCalls += 1; });
    assert.equal(rejected.success, false);
    assert.equal(rejected.error, 'UNSUPPORTED_AUTOMATION_ACTION');
    assert.equal(queryCalls, 0);
  }
});

test('automation action failures are reported and do not emit a successful execution event', async () => {
  const missingJob = await executeAutomationAction('escalate_priority', { companyId: 'tenant-a' }, async () => {
    assert.fail('query should not run without a job id');
  });
  assert.equal(missingJob.success, false);
  assert.equal(missingJob.error, 'JOB_ID_REQUIRED');

  const noMatch = await executeAutomationAction('escalate_priority', {
    companyId: 'tenant-a', jobId: 'missing',
  }, async () => ({ rowCount: 0, rows: [] }));
  assert.equal(noMatch.success, false);
  assert.equal(noMatch.error, 'JOB_NOT_FOUND');

  let emitted = 0;
  const outcome = await evaluateAutomationRules('sla_warning', { companyId: 'tenant-a' }, {
    query: async () => ({ rows: [{ id: 1, rule_name: 'legacy rule', action_type: 'auto_po' }] }),
    emitSystemEvent: async () => { emitted += 1; },
  });
  assert.equal(outcome.success, false);
  assert.equal(outcome.results[0].error, 'UNSUPPORTED_AUTOMATION_ACTION');
  assert.equal(emitted, 0);
});

test('automation successful mock evaluation emits only after a successful action', async () => {
  let queryCount = 0;
  let emitted = 0;
  const outcome = await evaluateAutomationRules('sla_warning', { companyId: 'tenant-a', jobId: 'job-1' }, {
    query: async () => {
      queryCount += 1;
      if (queryCount === 1) return { rows: [{ id: 3, rule_name: 'Escalate', action_type: 'escalate_priority' }] };
      return { rowCount: 1, rows: [{ id: 'job-1' }] };
    },
    emitSystemEvent: async () => { emitted += 1; },
  });
  assert.equal(outcome.success, true);
  assert.equal(outcome.results.length, 1);
  assert.equal(emitted, 1);
});

test('automation handler contract rejects unsupported UI action types before insertion', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '../routes/automationCenter.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../../SmartERP-Frontend/app/owner/cnc/automations/page.tsx'), 'utf8');
  assert.match(route, /SUPPORTED_AUTOMATION_ACTIONS\.includes\(action_type\)/);
  assert.match(ui, /SelectItem value="escalate_priority"/);
  assert.doesNotMatch(ui, /SelectItem value="(?:auto_pm|reserve_part|auto_po|notify_owner|notify_manager)"/);
  assert.match(ui, /business-event triggers are not connected/);
});

test('employee API README matches current authenticated role-guarded routes', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '../routes/employees.js'), 'utf8');
  assert.match(readme, /does not implement the previously documented `DEV_ALLOW_UNAUTH_USERS` bypass/);
  assert.match(readme, /require a valid authenticated token and company context/i);
  assert.ok(routes.includes("router.get('/', authenticateToken"));
  assert.ok(routes.includes("router.post('/', authenticateToken"));
  assert.ok(routes.includes("role !== 'owner' && role !== 'admin' && role !== 'hr'"));
});
