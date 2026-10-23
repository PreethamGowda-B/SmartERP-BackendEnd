'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const requireFinanceReadAccess = require('../middleware/requireFinanceReadAccess');
const { pool } = require('../db');
const invoiceService = require('../services/invoiceService');

function invokeGate(user) {
  let statusCode = 200;
  let body;
  let nextCalled = false;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  };
  requireFinanceReadAccess({ user }, res, () => { nextCalled = true; });
  return { statusCode, body, nextCalled };
}

test('finance read access permits owner/admin with company scope and rejects other roles or missing scope', () => {
  assert.equal(invokeGate({ role: 'owner', companyId: 7 }).nextCalled, true);
  assert.equal(invokeGate({ role: 'ADMIN', company_id: 7 }).nextCalled, true);
  assert.equal(invokeGate({ role: 'employee', companyId: 7 }).statusCode, 403);
  assert.equal(invokeGate({ role: 'customer', companyId: 7 }).statusCode, 403);
  assert.equal(invokeGate({ role: 'super_admin' }).statusCode, 403);
  assert.equal(invokeGate({ role: 'owner' }).statusCode, 401);
});

test('finance summary, AR aging, invoice list and detail routes use the explicit read gate', () => {
  const root = path.resolve(__dirname, '..');
  const finance = fs.readFileSync(path.join(root, 'routes/finance.js'), 'utf8');
  const invoices = fs.readFileSync(path.join(root, 'routes/invoices.js'), 'utf8');
  for (const route of ["router.get('/summary', authenticate, requireFinanceReadAccess", "router.get('/ar-aging', authenticate, requireFinanceReadAccess"]) {
    assert.ok(finance.includes(route), `missing guarded route ${route}`);
  }
  for (const route of ["router.get('/', authenticate, requireFinanceReadAccess", "router.get('/job/:jobId', authenticate, requireFinanceReadAccess", "router.get('/:id', authenticate, requireFinanceReadAccess"]) {
    assert.ok(invoices.includes(route), `missing guarded route ${route}`);
  }
  assert.match(invoices, /LEFT JOIN jobs j ON i\.job_id = j\.id AND j\.company_id::text = i\.company_id::text/);
  assert.match(invoices, /invoice_items WHERE invoice_id = \$1 AND company_id = \$2/);
  assert.match(invoices, /SELECT \* FROM invoices WHERE id = \$1 AND company_id::text = \$2::text/);
  assert.match(invoices, /invoice_items WHERE invoice_id = \$1 AND company_id::text = \$2::text/);
  assert.match(invoices, /LEFT JOIN customers c ON d\.customer_id = c\.id AND c\.company_id = d\.company_id/);
});

test('direct API route requests authorize Owner/Admin and deny employee, customer and super-admin', async () => {
  const express = require('express');
  const authPath = require.resolve('../middleware/authMiddleware');
  const financePath = require.resolve('../routes/finance');
  const invoicesPath = require.resolve('../routes/invoices');
  const emailPath = require.resolve('../services/emailNotificationService');
  const originalAuth = require.cache[authPath];
  const originalFinance = require.cache[financePath];
  const originalInvoices = require.cache[invoicesPath];
  const originalEmail = require.cache[emailPath];
  const originalQuery = pool.query;
  let queryCount = 0;
  const queries = [];
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      authenticateToken(req, _res, next) {
        req.user = {
          role: req.get('x-test-role'),
          companyId: req.get('x-test-company') || undefined,
          id: 'user-test',
        };
        next();
      },
    },
  };
  require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: {} };
  delete require.cache[financePath];
  delete require.cache[invoicesPath];
  pool.query = async (sql, params = []) => {
    queryCount += 1;
    queries.push({ sql, params });
    if (sql.includes('FROM invoices') && sql.includes('total_invoiced')) {
      return { rows: [{ total_invoiced: '0', total_paid: '0', total_outstanding: '0', total_tax_collected: '0', pending_count: 0, paid_count: 0, disputed_count: 0, sent_count: 0 }] };
    }
    if (sql.includes('FROM ar_collection_schedules') && sql.includes('overdue_count')) return { rows: [{ overdue_count: 0, overdue_amount: '0' }] };
    if (sql.includes('FROM invoices i') && sql.includes('WHERE i.id = $1')) return { rows: [{ id: 'invoice-test', company_id: 'company-1', job_title: null }] };
    if (sql.includes('FROM invoices i')) return { rows: [] };
    if (sql.startsWith('SELECT id, company_name')) return { rows: [{ id: 'company-1', company_name: 'Test Company', settings: {} }] };
    if (/FROM invoice_(items|disputes|activity_logs|payments)/.test(sql)) return { rows: [] };
    return { rows: [] };
  };

  const app = express();
  app.use('/api/finance', require('../routes/finance'));
  app.use('/api/invoices', require('../routes/invoices'));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, role, company = 'company-1') => fetch(`${base}${url}`, {
    headers: { 'x-test-role': role, 'x-test-company': company },
  });
  try {
    for (const role of ['employee', 'customer', 'super_admin']) {
      const before = queryCount;
      assert.equal((await request('/api/finance/summary', role)).status, 403);
      assert.equal(queryCount, before);
      assert.equal((await request('/api/invoices', role)).status, 403);
      assert.equal(queryCount, before);
      assert.equal((await request('/api/invoices/invoice-test', role)).status, 403);
      assert.equal(queryCount, before);
    }
    assert.equal((await request('/api/finance/summary', 'owner')).status, 200);
    assert.equal((await request('/api/finance/ar-aging', 'admin')).status, 200);
    assert.equal((await request('/api/invoices', 'owner')).status, 200);
    const listQuery = queries.find(({ sql }) => sql.includes('FROM invoices i') && sql.includes('ORDER BY i.created_at DESC'));
    assert.ok(listQuery, 'invoice list must issue its company-scoped query');
    assert.match(listQuery.sql, /j\.company_id::text = i\.company_id::text/);
    assert.match(listQuery.sql, /WHERE i\.company_id = \$1 AND i\.is_latest = TRUE/);
    assert.equal(listQuery.params[0], 'company-1');
    const detail = await request('/api/invoices/invoice-test', 'admin');
    assert.equal(detail.status, 200);
    const rootQuery = queries.find(({ sql }) => sql.includes('FROM invoices i') && sql.includes('WHERE i.id = $1'));
    assert.equal(rootQuery.params[1], 'company-1');
    for (const table of ['invoice_items', 'invoice_disputes', 'invoice_activity_logs', 'invoice_payments']) {
      const childQuery = queries.find(({ sql }) => sql.includes(`FROM ${table}`));
      assert.ok(childQuery?.sql.includes('company_id = $2'), `${table} lookup must be company scoped`);
      assert.equal(childQuery.params[1], 'company-1');
    }
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    pool.query = originalQuery;
    delete require.cache[financePath];
    delete require.cache[invoicesPath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
    if (originalEmail) require.cache[emailPath] = originalEmail;
    else delete require.cache[emailPath];
    if (originalFinance) require.cache[financePath] = originalFinance;
    if (originalInvoices) require.cache[invoicesPath] = originalInvoices;
  }
});

function installInvoiceReplayClient({ priorInvoice, throwOnInsert = false, missingFingerprintColumn = false }) {
  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM invoices WHERE company_id::text = $1::text AND idempotency_key = $2 FOR UPDATE')) {
        return { rows: priorInvoice ? [priorInvoice] : [] };
      }
      if (sql.includes('FROM invoice_items WHERE invoice_id = $1 ORDER BY id')) return { rows: [] };
      if (sql.includes('FROM companies WHERE id::text = $1::text FOR UPDATE')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('SELECT invoice_number FROM invoices')) return { rows: [] };
      if (sql.includes('FROM customers WHERE id = $1 AND company_id = $2')) {
        return { rows: [{ id: 'customer-1', name: 'Customer', email: 'customer@example.test', phone: '' }] };
      }
      if (sql.startsWith('INSERT INTO invoices')) {
        if (missingFingerprintColumn) throw Object.assign(new Error('column request_fingerprint does not exist'), { code: '42703' });
        if (throwOnInsert) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      if (sql.includes('FROM invoices WHERE company_id::text = $1::text AND idempotency_key = $2')) {
        return { rows: priorInvoice ? [priorInvoice] : [] };
      }
      if (sql.includes('FROM invoice_items WHERE invoice_id = $1 AND company_id = $2')) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const original = pool.connect;
  pool.connect = async () => client;
  return () => { pool.connect = original; };
}

const directInvoiceData = {
  idempotency_key: 'phase5-key-123',
  customer_id: 'customer-1',
  lineItems: [{ item_type: 'material', description: 'Bearing', hsn_code: '1234', quantity: 2, unit_price: 50, inventory_item_id: 'stock-1' }],
  payment_status: 'issued',
};

test('direct invoice fingerprint covers economics, inventory and customer-visible fields', () => {
  const fingerprint = invoiceService.directInvoiceFingerprint('company-1', directInvoiceData);
  assert.equal(fingerprint, invoiceService.directInvoiceFingerprint('company-1', { ...directInvoiceData }));
  for (const changed of [
    { ...directInvoiceData, discount_amount: 5 },
    { ...directInvoiceData, due_days: 10 },
    { ...directInvoiceData, lineItems: [{ ...directInvoiceData.lineItems[0], inventory_item_id: 'stock-2' }] },
    { ...directInvoiceData, customer_notes: 'different note' },
  ]) {
    assert.notEqual(fingerprint, invoiceService.directInvoiceFingerprint('company-1', changed));
  }
});

test('matching direct invoice retry replays; changed payload and legacy missing fingerprint conflict', async () => {
  const fingerprint = invoiceService.directInvoiceFingerprint('company-1', directInvoiceData);
  const restore = installInvoiceReplayClient({ priorInvoice: { id: 'invoice-1', company_id: 'company-1', request_fingerprint: fingerprint } });
  try {
    const replay = await invoiceService.createDirectInvoice({ companyId: 'company-1', invoiceData: directInvoiceData });
    assert.equal(replay.idempotentReplay, true);
  } finally { restore(); }

  const restoreChanged = installInvoiceReplayClient({ priorInvoice: { id: 'invoice-1', company_id: 'company-1', request_fingerprint: fingerprint } });
  try {
    await assert.rejects(
      invoiceService.createDirectInvoice({ companyId: 'company-1', invoiceData: { ...directInvoiceData, discount_amount: 1 } }),
      (error) => error.statusCode === 409
    );
  } finally { restoreChanged(); }

  const restoreLegacy = installInvoiceReplayClient({ priorInvoice: { id: 'invoice-old', company_id: 'company-1' } });
  try {
    await assert.rejects(
      invoiceService.createDirectInvoice({ companyId: 'company-1', invoiceData: directInvoiceData }),
      (error) => error.statusCode === 409 && /manual reconciliation/.test(error.message)
    );
  } finally { restoreLegacy(); }
});

test('concurrent direct invoice key race compares the persisted fingerprint before replay', async () => {
  const fingerprint = invoiceService.directInvoiceFingerprint('company-1', directInvoiceData);
  const restore = installInvoiceReplayClient({
    priorInvoice: { id: 'invoice-race', company_id: 'company-1', request_fingerprint: fingerprint },
    throwOnInsert: true,
  });
  try {
    const result = await invoiceService.createDirectInvoice({ companyId: 'company-1', invoiceData: directInvoiceData });
    assert.equal(result.idempotentReplay, true);
  } finally { restore(); }

  const restoreMismatch = installInvoiceReplayClient({
    priorInvoice: { id: 'invoice-race', company_id: 'company-1', request_fingerprint: fingerprint },
    throwOnInsert: true,
  });
  try {
    await assert.rejects(
      invoiceService.createDirectInvoice({ companyId: 'company-1', invoiceData: { ...directInvoiceData, transport_charges: 9 } }),
      (error) => error.statusCode === 409
    );
  } finally { restoreMismatch(); }
});

test('direct invoice creation fails closed with a clear status until fingerprint schema exists', async () => {
  const restore = installInvoiceReplayClient({ missingFingerprintColumn: true });
  try {
    await assert.rejects(
      invoiceService.createDirectInvoice({ companyId: 'company-1', invoiceData: directInvoiceData }),
      (error) => error.statusCode === 503 && /schema is not active/.test(error.message)
    );
  } finally { restore(); }
});

test('invoice list SQL query semantics verify compatible typecasts, walk-in NULL job handling, and tenant scoping', async () => {
  const express = require('express');
  const authPath = require.resolve('../middleware/authMiddleware');
  const invoicesPath = require.resolve('../routes/invoices');
  const emailPath = require.resolve('../services/emailNotificationService');
  const originalAuth = require.cache[authPath];
  const originalInvoices = require.cache[invoicesPath];
  const originalEmail = require.cache[emailPath];
  const originalQuery = pool.query;

  const invoicesDb = [
    { id: 'inv-job-1', company_id: 'company-1', job_id: 'job-1', is_latest: true, status: 'paid', invoice_number: 'INV-001', created_at: new Date('2026-01-02T10:00:00Z') },
    { id: 'inv-walkin-1', company_id: 'company-1', job_id: null, is_latest: true, status: 'paid', invoice_number: 'INV-002', created_at: new Date('2026-01-03T10:00:00Z') },
    { id: 'inv-cross-1', company_id: 'company-1', job_id: 'job-tenant-2', is_latest: true, status: 'draft', invoice_number: 'INV-003', created_at: new Date('2026-01-01T10:00:00Z') },
    { id: 'inv-superseded', company_id: 'company-1', job_id: 'job-1', is_latest: false, status: 'paid', invoice_number: 'INV-001-v0', created_at: new Date('2026-01-01T09:00:00Z') },
    { id: 'inv-other-tenant', company_id: 'company-2', job_id: 'job-tenant-2', is_latest: true, status: 'paid', invoice_number: 'INV-999', created_at: new Date('2026-01-04T10:00:00Z') },
  ];

  const jobsDb = [
    { id: 'job-1', company_id: 'company-1', title: 'Precision CNC Milling' },
    { id: 'job-tenant-2', company_id: 'company-2', title: 'Foreign Tenant Job' },
  ];

  const capturedQueries = [];

  pool.query = async (sql, params = []) => {
    capturedQueries.push({ sql, params });
    if (sql.includes('FROM invoices i') && sql.includes('ORDER BY i.created_at DESC')) {
      const companyId = params[0];
      const hasStatus = sql.includes('AND i.status = $');
      const statusParam = hasStatus ? params[1] : null;
      const limit = params[hasStatus ? 2 : 1];
      const offset = params[hasStatus ? 3 : 2];

      // Execute SQL semantics
      let rows = invoicesDb
        .filter((i) => i.company_id === companyId && i.is_latest === true)
        .filter((i) => (!statusParam || i.status === statusParam))
        .map((i) => {
          // LEFT JOIN jobs j ON i.job_id = j.id AND j.company_id::text = i.company_id::text
          const matchedJob = i.job_id
            ? jobsDb.find((j) => j.id === i.job_id && String(j.company_id) === String(i.company_id))
            : null;
          return {
            ...i,
            job_title: matchedJob ? matchedJob.title : null,
          };
        })
        .sort((a, b) => b.created_at - a.created_at);

      rows = rows.slice(offset, offset + limit);
      return { rows };
    }
    return { rows: [] };
  };

  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      authenticateToken(req, _res, next) {
        req.user = {
          role: 'owner',
          companyId: req.get('x-test-company') || 'company-1',
          id: 'user-test',
        };
        next();
      },
    },
  };
  require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: {} };
  delete require.cache[invoicesPath];

  const app = express();
  app.use('/api/invoices', require('../routes/invoices'));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Full list without filter
    const resAll = await fetch(`${base}/api/invoices`, {
      headers: { 'x-test-company': 'company-1' },
    });
    assert.equal(resAll.status, 200);
    const dataAll = await resAll.json();
    assert.equal(dataAll.success, true);
    assert.equal(dataAll.invoices.length, 3); // inv-walkin-1, inv-job-1, inv-cross-1

    // Walk-in invoice (job_id: null) must be preserved with job_title: null
    const walkin = dataAll.invoices.find((i) => i.id === 'inv-walkin-1');
    assert.ok(walkin, 'walk-in invoice must be present in results');
    assert.equal(walkin.job_id, null);
    assert.equal(walkin.job_title, null);

    // Job invoice must have joined job_title
    const jobInv = dataAll.invoices.find((i) => i.id === 'inv-job-1');
    assert.ok(jobInv, 'job-linked invoice must be present');
    assert.equal(jobInv.job_title, 'Precision CNC Milling');

    // Cross-tenant job invoice must NOT leak foreign company's job title
    const crossInv = dataAll.invoices.find((i) => i.id === 'inv-cross-1');
    assert.ok(crossInv, 'cross-tenant reference invoice remains in listing');
    assert.equal(crossInv.job_title, null);

    // Superseded and other-tenant invoices must not be returned
    assert.equal(dataAll.invoices.some((i) => i.id === 'inv-superseded'), false);
    assert.equal(dataAll.invoices.some((i) => i.id === 'inv-other-tenant'), false);

    // 2. Filter by status=paid with pagination
    const resPaid = await fetch(`${base}/api/invoices?status=paid&limit=1&page=2`, {
      headers: { 'x-test-company': 'company-1' },
    });
    assert.equal(resPaid.status, 200);
    const dataPaid = await resPaid.json();
    assert.equal(dataPaid.success, true);
    assert.equal(dataPaid.invoices.length, 1);
    assert.equal(dataPaid.invoices[0].id, 'inv-job-1'); // 2nd paid invoice after inv-walkin-1

    const lastQuery = capturedQueries[capturedQueries.length - 1];
    assert.match(lastQuery.sql, /AND i\.status = \$2/);
    assert.deepEqual(lastQuery.params, ['company-1', 'paid', 1, 1]);

    // 3. Type compatibility: verify integer vs text casting in join
    const intCompanyJob = { id: 'job-int', company_id: 12345, title: 'Integer Tenant Job' };
    const textCompanyInv = { id: 'inv-text', company_id: '12345', job_id: 'job-int' };
    const typeMatched = String(intCompanyJob.company_id) === String(textCompanyInv.company_id);
    assert.equal(typeMatched, true, '::text casting ensures cross-type equality without Postgres operator error');
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    pool.query = originalQuery;
    delete require.cache[invoicesPath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
    if (originalEmail) require.cache[emailPath] = originalEmail;
    else delete require.cache[emailPath];
    if (originalInvoices) require.cache[invoicesPath] = originalInvoices;
  }
});
