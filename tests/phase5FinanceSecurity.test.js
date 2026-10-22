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
  assert.match(invoices, /LEFT JOIN jobs j ON i\.job_id = j\.id AND j\.company_id = i\.company_id/);
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
