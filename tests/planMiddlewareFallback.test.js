'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const redisModulePath = require.resolve('../utils/redis');
const originalRedisModule = require.cache[redisModulePath];
require.cache[redisModulePath] = {
  id: redisModulePath, filename: redisModulePath, loaded: true, exports: { redisClient: null },
};
const { pool } = require('../db');
const { loadPlan } = require('../middleware/planMiddleware');

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invokeLoadPlan(companyId) {
  const req = { user: companyId ? { role: 'owner', companyId } : { role: 'owner' } };
  const res = responseRecorder();
  let nextCalls = 0;
  await loadPlan(req, res, () => { nextCalls += 1; });
  return { req, res, nextCalls };
}

test('confirmed company with null plan relationship uses Starter fallback', async (t) => {
  const originalQuery = pool.query;
  const companyId = `unit-test-null-plan-${Date.now()}`;
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM companies c')) {
      return { rows: [{ company_record_id: companyId, company_plan_id: null, plan_db_id: null }] };
    }
    return { rows: [{ id: 1, name: 'Starter', features: { ai_assistant: true } }] };
  };
  t.after(() => { pool.query = originalQuery; });

  const result = await invokeLoadPlan(companyId);
  assert.equal(result.nextCalls, 1);
  assert.equal(result.req.plan.id, 1);
  assert.equal(calls.length, 2);
});

test('missing company is denied and never falls back to Starter', async (t) => {
  const originalQuery = pool.query;
  let calls = 0;
  pool.query = async () => { calls += 1; return { rows: [] }; };
  t.after(() => { pool.query = originalQuery; });

  const result = await invokeLoadPlan(`unit-test-missing-company-${Date.now()}`);
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.nextCalls, 0);
  assert.equal(calls, 1);
});

test('company identity mismatch is denied without fallback', async (t) => {
  const originalQuery = pool.query;
  let calls = 0;
  pool.query = async () => {
    calls += 1;
    return { rows: [{ company_record_id: 'different-company', company_plan_id: null, plan_db_id: null }] };
  };
  t.after(() => { pool.query = originalQuery; });

  const result = await invokeLoadPlan(`unit-test-claimed-company-${Date.now()}`);
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.nextCalls, 0);
  assert.equal(calls, 1);
});

test('missing Starter plan record fails closed after a confirmed missing company plan', async (t) => {
  const originalQuery = pool.query;
  let calls = 0;
  const companyId = `unit-test-no-starter-${Date.now()}`;
  pool.query = async (sql) => {
    calls += 1;
    if (sql.includes('FROM companies c')) {
      return { rows: [{ company_record_id: companyId, company_plan_id: null, plan_db_id: null }] };
    }
    return { rows: [] };
  };
  t.after(() => { pool.query = originalQuery; });

  const result = await invokeLoadPlan(companyId);
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.nextCalls, 0);
  assert.equal(calls, 2);
});

test('database lookup error returns service failure without Starter fallback', async (t) => {
  const originalQuery = pool.query;
  let calls = 0;
  pool.query = async () => { calls += 1; throw new Error('mocked database unavailable'); };
  t.after(() => { pool.query = originalQuery; });

  const result = await invokeLoadPlan(`unit-test-db-error-${Date.now()}`);
  assert.equal(result.res.statusCode, 500);
  assert.equal(result.nextCalls, 0);
  assert.equal(calls, 1);
});

test('dangling plan ID fails closed instead of using Starter', async (t) => {
  const originalQuery = pool.query;
  let calls = 0;
  pool.query = async (sql) => {
    calls += 1;
    assert.match(sql, /LEFT JOIN plans/);
    return { rows: [{
      company_record_id: 'unit-test-dangling-plan',
      company_plan_id: 987654,
      plan_db_id: null,
    }] };
  };
  t.after(() => { pool.query = originalQuery; });

  const result = await invokeLoadPlan('unit-test-dangling-plan');
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.nextCalls, 0);
  assert.equal(calls, 1);
});

test('an unsupported non-null plan ID fails closed without fallback', async (t) => {
  const originalQuery = pool.query;
  let calls = 0;
  pool.query = async () => {
    calls += 1;
    return { rows: [{
      company_record_id: 'unit-test-invalid-plan',
      company_plan_id: 987654,
      plan_db_id: 987654,
    }] };
  };
  t.after(() => { pool.query = originalQuery; });

  const result = await invokeLoadPlan('unit-test-invalid-plan');
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.nextCalls, 0);
  assert.equal(calls, 1);
});

test('missing company context never falls back or invents a plan', async () => {
  const result = await invokeLoadPlan(null);
  assert.equal(result.nextCalls, 1);
  assert.equal(result.req.plan, undefined);
  assert.equal(result.res.statusCode, null);
});

test('a missing company context cannot pass the required AI feature guard', async () => {
  const { requireFeature } = require('../middleware/featureGuard');
  const result = await invokeLoadPlan(null);
  const res = responseRecorder();
  let nextCalls = 0;
  requireFeature('ai_assistant')(result.req, res, () => { nextCalls += 1; });
  assert.equal(res.statusCode, 500);
  assert.equal(nextCalls, 0);
});

test.after(() => {
  if (originalRedisModule) require.cache[redisModulePath] = originalRedisModule;
  else delete require.cache[redisModulePath];
});
