'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const routePath = require.resolve('../routes/workRequests');
const originalLoad = Module._load;
const schemaQueryLog = [];
const schemaPool = {
  async query(sql, params = []) { schemaQueryLog.push({ sql, params }); return { rows: [] }; },
  async connect() {
    return {
      query: async (sql, params = []) => { schemaQueryLog.push({ sql, params }); return { rows: [] }; },
      release() {},
    };
  },
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename === routePath && request === '../db') return { pool: schemaPool };
  if (parent?.filename === routePath && request === '../utils/notificationHelpers') {
    return { createNotification: async () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let createWorkRequestActionHandler;
let ensureWorkRequestsTable;
try {
  ({ createWorkRequestActionHandler, ensureWorkRequestsTable } = require(routePath));
} finally {
  Module._load = originalLoad;
}

const baseRequest = {
  id: 'request-a',
  company_id: 'company-a',
  status: 'pending',
  invoice_id: 'invoice-a',
  request_type: 'invoice_discount',
  payload: { discount_amount: 20 },
  submitted_by_id: 'employee-a',
  title: 'Discount request',
};

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function mockDatabase({
  request = baseRequest,
  invoice = { id: 'invoice-a', company_id: 'company-a', subtotal: 100 },
  job = { id: 'job-a', company_id: 'company-a' },
  employee = { id: 'employee-a', company_id: 'company-a' },
  failUpdate = false,
  failInvoiceUpdate = false,
} = {}) {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT * FROM work_requests')) return { rows: request ? [request] : [] };
      if (sql.startsWith('SELECT * FROM invoices')) return { rows: invoice ? [invoice] : [] };
      if (sql.startsWith('SELECT id FROM jobs')) return { rows: job ? [job] : [] };
      if (sql.startsWith('SELECT id FROM users')) return { rows: employee ? [employee] : [] };
      if (sql.startsWith('UPDATE invoices')) {
        if (failInvoiceUpdate) throw Object.assign(new Error('private SQL detail'), { code: 'XX000' });
        return { rows: [{ id: 'invoice-a' }] };
      }
      if (sql.startsWith('UPDATE jobs')) return { rows: [{ id: 'job-a' }] };
      if (sql.startsWith('UPDATE work_requests')) {
        if (failUpdate) throw Object.assign(new Error('private SQL detail'), { code: 'XX000' });
        return { rows: [{ ...request, status: params[0] }] };
      }
      throw new Error(`Unexpected SQL in mock: ${sql}`);
    },
    release() { released = true; },
  };
  return { db: { connect: async () => client }, queries, wasReleased: () => released };
}

const makeRequest = (body = {}) => ({
  user: { id: 'owner-a', name: 'Owner', role: 'owner', companyId: 'company-a' },
  params: { id: 'request-a' },
  body: { action: 'approve', ...body },
});

test('work request approval applies invoice changes and request status in one company-scoped transaction', async () => {
  const mock = mockDatabase();
  const notifications = [];
  let committedBeforeNotification = false;
  const handler = createWorkRequestActionHandler({
    db: mock.db,
    ensureSchema: async () => {},
    notify: async (notification) => {
      committedBeforeNotification = mock.queries.some(({ sql }) => sql === 'COMMIT');
      notifications.push(notification);
    },
  });
  const res = response();

  await handler(makeRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(mock.queries[0].sql === 'BEGIN');
  assert.ok(mock.queries.some(({ sql, params }) => sql.startsWith('SELECT * FROM invoices')
    && sql.includes('company_id::text = $2::text') && sql.includes('FOR UPDATE') && params[1] === 'company-a'));
  assert.ok(mock.queries.some(({ sql }) => sql.startsWith('UPDATE invoices') && sql.includes('company_id::text = $4::text')));
  assert.ok(mock.queries.some(({ sql }) => sql.startsWith('UPDATE work_requests') && sql.includes('company_id::text = $9::text')));
  assert.ok(mock.queries.some(({ sql }) => sql === 'COMMIT'));
  assert.equal(committedBeforeNotification, true);
  assert.equal(notifications[0].company_id, 'company-a');
  assert.equal(mock.wasReleased(), true);
});

test('additional-worker approval locks and scopes job and employee before assignment', async () => {
  const request = {
    ...baseRequest,
    invoice_id: null,
    job_id: 'job-a',
    request_type: 'need_more_workers',
  };
  const mock = mockDatabase({ request, invoice: null });
  const handler = createWorkRequestActionHandler({ db: mock.db, ensureSchema: async () => {}, notify: async () => {} });
  const res = response();

  await handler(makeRequest({ payload: { assigned_employee_id: 'employee-a' } }), res);

  assert.equal(res.statusCode, 200);
  assert.ok(mock.queries.some(({ sql, params }) => sql.startsWith('SELECT id FROM jobs')
    && sql.includes('company_id::text = $2::text') && sql.includes('FOR UPDATE')
    && params[0] === 'job-a' && params[1] === 'company-a'));
  assert.ok(mock.queries.some(({ sql, params }) => sql.startsWith('SELECT id FROM users')
    && sql.includes('company_id::text = $2::text')
    && params[0] === 'employee-a' && params[1] === 'company-a'));
  assert.ok(mock.queries.some(({ sql, params }) => sql.startsWith('UPDATE jobs')
    && sql.includes('company_id::text = $3::text') && params[2] === 'company-a'));
  assert.ok(mock.queries.some(({ sql }) => sql === 'COMMIT'));
});

test('cross-company linked invoice blocks approval and rolls back the request update', async () => {
  const mock = mockDatabase({ invoice: null });
  const handler = createWorkRequestActionHandler({ db: mock.db, ensureSchema: async () => {}, notify: async () => {} });
  const res = response();

  await handler(makeRequest(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.success, undefined);
  assert.match(res.body.message, /not found for this company/);
  assert.ok(mock.queries.some(({ sql }) => sql === 'ROLLBACK'));
  assert.equal(mock.queries.some(({ sql }) => sql.startsWith('UPDATE work_requests')), false);
});

test('work-request database failure rolls back and returns a sanitized error', async () => {
  const mock = mockDatabase({ failUpdate: true });
  const handler = createWorkRequestActionHandler({ db: mock.db, ensureSchema: async () => {}, notify: async () => {} });
  const res = response();

  await handler(makeRequest(), res);

  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(res.body), /private SQL|XX000/);
  assert.ok(mock.queries.some(({ sql }) => sql === 'ROLLBACK'));
  assert.equal(mock.queries.some(({ sql }) => sql === 'COMMIT'), false);
  assert.equal(mock.wasReleased(), true);
});

test('linked invoice update failure rolls back before changing work-request status', async () => {
  const mock = mockDatabase({ failInvoiceUpdate: true });
  const handler = createWorkRequestActionHandler({ db: mock.db, ensureSchema: async () => {}, notify: async () => {} });
  const res = response();

  await handler(makeRequest(), res);

  assert.equal(res.statusCode, 500);
  assert.ok(mock.queries.some(({ sql }) => sql === 'ROLLBACK'));
  assert.equal(mock.queries.some(({ sql }) => sql.startsWith('UPDATE work_requests')), false);
  assert.equal(mock.queries.some(({ sql }) => sql === 'COMMIT'), false);
});

test('unsupported work-request action is rejected before opening a transaction', async () => {
  let connected = false;
  const handler = createWorkRequestActionHandler({
    db: { connect: async () => { connected = true; throw new Error('should not connect'); } },
    ensureSchema: async () => {},
    notify: async () => {},
  });
  const res = response();

  await handler(makeRequest({ action: 'invented_action' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});

test('module-load schema initializer is isolated from a real pool in this test file', async () => {
  if (ensureWorkRequestsTable) {
    await ensureWorkRequestsTable();
  }
  assert.ok(schemaQueryLog.some(({ sql }) => /CREATE TABLE IF NOT EXISTS work_requests/i.test(sql)));
});
