'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../db');
const invoiceService = require('../services/invoiceService');

function installClient({
  invoice = { id: 'invoice-1', company_id: 'company-a', total_amount: '100.00', amount_paid: '20.00', amount_due: '80.00', job_id: null },
  failUpdate = false,
  persistedPayments = new Map(),
  conflictOnInsert = null,
  uncertainCommit = false,
  schemaMissing = false,
  afterInvoiceRead = null,
} = {}) {
  const calls = [];
  let insertedCount = 0;
  let commitFailed = false;
  let committed = false;
  let transactionSnapshot = null;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'COMMIT' && uncertainCommit && !commitFailed) {
        commitFailed = true;
        committed = true;
        throw Object.assign(new Error('Simulated lost commit response'), { code: '08006' });
      }
      if (sql === 'BEGIN') {
        transactionSnapshot = {
          payments: new Map(persistedPayments),
          invoice: { ...invoice },
        };
        return { rows: [] };
      }
      if (sql === 'COMMIT') {
        committed = true;
        return { rows: [] };
      }
      if (sql === 'ROLLBACK') {
        if (!committed && transactionSnapshot) {
          persistedPayments.clear();
          for (const [key, row] of transactionSnapshot.payments) persistedPayments.set(key, row);
          Object.assign(invoice, transactionSnapshot.invoice);
        }
        return { rows: [] };
      }
      if (sql.startsWith('SAVEPOINT') || sql.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [] };
      if (sql.startsWith('SELECT invoice_id, request_fingerprint')) {
        if (schemaMissing) throw Object.assign(new Error('column does not exist'), { code: '42703' });
        const stored = persistedPayments.get(String(params[0]) + ':' + String(params[1]));
        return { rows: stored ? [stored] : [] };
      }
      if (sql.startsWith('SELECT * FROM invoices')) {
        assert.match(sql, /company_id = \$2 FOR UPDATE/);
        if (afterInvoiceRead) await afterInvoiceRead(invoice, persistedPayments);
        return { rows: invoice ? [invoice] : [] };
      }
      if (sql.startsWith('INSERT INTO invoice_payments')) {
        insertedCount += 1;
        if (sql.includes('idempotency_key')) {
          const [invoiceId, companyId, paymentMethod, transactionReference, amount, notes, recordedBy,
            key, fingerprint, status, amountPaid, amountDue] = params;
          const mapKey = String(companyId) + ':' + String(key);
          if (conflictOnInsert && !persistedPayments.has(mapKey)) {
            persistedPayments.set(mapKey, conflictOnInsert);
            throw Object.assign(new Error('Simulated unique index race'), { code: '23505' });
          }
          if (persistedPayments.has(mapKey)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
          persistedPayments.set(mapKey, {
            invoice_id: invoiceId,
            payment_method: paymentMethod,
            transaction_reference: transactionReference,
            amount,
            notes,
            recorded_by: recordedBy,
            request_fingerprint: fingerprint,
            result_status: status,
            result_amount_paid: amountPaid,
            result_amount_due: amountDue,
          });
          return { rows: [{ id: 9 }] };
        }
        return { rows: [{ id: 9 }] };
      }
      if (sql.startsWith('UPDATE invoices')) {
        if (failUpdate) throw Object.assign(new Error('private SQL detail'), { code: 'XX000' });
        invoice.amount_paid = params[0];
        invoice.amount_due = params[1];
        invoice.status = params[2];
        return { rows: [{ id: invoice.id }] };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return { calls, client, invoice, persistedPayments, get insertedCount() { return insertedCount; } };
}

test('manual invoice payments require a valid positive method and amount before acquiring a DB client', async () => {
  const originalConnect = pool.connect;
  let connected = false;
  pool.connect = async () => { connected = true; throw new Error('Unexpected connection'); };
  try {
    for (const amount of [-1, 0, 'Infinity', 'not-a-number']) {
      await assert.rejects(
        invoiceService.recordPayment({ invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'cash', amount }),
        (error) => error.statusCode === 400,
      );
    }
    await assert.rejects(
      invoiceService.recordPayment({ invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'invented', amount: 10 }),
      (error) => error.statusCode === 400,
    );
    assert.equal(connected, false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('partial payment uses paise rounding and persists payment and invoice totals in one transaction', async () => {
  const originalConnect = pool.connect;
  const mock = installClient();
  pool.connect = async () => mock.client;
  try {
    const result = await invoiceService.recordPayment({
      invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'UPI', amount: '30.10',
      transactionReference: 'UPI-1', recordedBy: 'owner-a',
    });
    assert.deepEqual(result, { success: true, status: 'partially_paid', amountPaid: 50.1, amountDue: 49.9 });
    const insert = mock.calls.find(({ sql }) => sql.startsWith('INSERT INTO invoice_payments'));
    assert.equal(insert.params[2], 'upi');
    assert.equal(insert.params[4], 30.1);
    const update = mock.calls.find(({ sql }) => sql.startsWith('UPDATE invoices'));
    assert.deepEqual(update.params.slice(0, 3), [50.1, 49.9, 'partially_paid']);
    assert.ok(mock.calls.some(({ sql }) => sql === 'COMMIT'));
  } finally {
    pool.connect = originalConnect;
  }
});

test('payment larger than the company invoice balance rolls back without writing a payment', async () => {
  const originalConnect = pool.connect;
  const mock = installClient();
  pool.connect = async () => mock.client;
  try {
    await assert.rejects(
      invoiceService.recordPayment({ invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'cash', amount: 80.01 }),
      (error) => error.statusCode === 409,
    );
    assert.equal(mock.calls.some(({ sql }) => sql.startsWith('INSERT INTO invoice_payments')), false);
    assert.ok(mock.calls.some(({ sql }) => sql === 'ROLLBACK'));
  } finally {
    pool.connect = originalConnect;
  }
});

test('full payment settles AR and closes only the job in the invoice company', async () => {
  const originalConnect = pool.connect;
  const mock = installClient({ invoice: { id: 'invoice-1', company_id: 'company-a', total_amount: 100, amount_paid: 20, job_id: 'job-a' } });
  pool.connect = async () => mock.client;
  try {
    const result = await invoiceService.recordPayment({ invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'bank_transfer', amount: 80 });
    assert.equal(result.status, 'paid');
    const ar = mock.calls.find(({ sql }) => sql.startsWith('UPDATE ar_collection_schedules'));
    const job = mock.calls.find(({ sql }) => sql.startsWith('UPDATE jobs'));
    assert.deepEqual(ar.params, ['invoice-1', 'company-a']);
    assert.match(job.sql, /company_id::text = \$2::text/);
    assert.deepEqual(job.params, ['job-a', 'company-a']);
    assert.ok(mock.calls.some(({ sql }) => sql === 'COMMIT'));
  } finally {
    pool.connect = originalConnect;
  }
});

test('payment persistence failure rolls back and does not expose database details', async () => {
  const originalConnect = pool.connect;
  const mock = installClient({ failUpdate: true });
  pool.connect = async () => mock.client;
  try {
    await assert.rejects(
      invoiceService.recordPayment({ invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'cash', amount: 10 }),
      (error) => error.statusCode === 500 && !/private SQL|XX000/.test(error.message),
    );
    assert.ok(mock.calls.some(({ sql }) => sql === 'ROLLBACK'));
    assert.equal(mock.calls.some(({ sql }) => sql === 'COMMIT'), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('same idempotency key and fingerprint replays the original persisted outcome', async () => {
  const originalConnect = pool.connect;
  const mock = installClient();
  pool.connect = async () => mock.client;
  try {
    const intent = {
      invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'UPI', amount: '30.10',
      transactionReference: ' ref-1 ', notes: 'counter receipt', idempotencyKey: 'payment-key-0001',
    };
    const first = await invoiceService.recordPayment(intent);
    const replay = await invoiceService.recordPayment({ ...intent, paymentMethod: 'upi', transactionReference: 'ref-1', notes: 'counter receipt' });
    assert.deepEqual(first, { success: true, status: 'partially_paid', amountPaid: 50.1, amountDue: 49.9 });
    assert.deepEqual(replay, first);
    assert.equal(mock.insertedCount, 1);
  } finally {
    pool.connect = originalConnect;
  }
});

test('reusing a key with a changed amount, invoice, or payment method is rejected', async () => {
  const originalConnect = pool.connect;
  const mock = installClient();
  pool.connect = async () => mock.client;
  try {
    const base = {
      invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'cash', amount: 10,
      transactionReference: 'receipt-1', notes: 'installment', idempotencyKey: 'payment-key-0002',
    };
    await invoiceService.recordPayment(base);
    for (const changed of [
      { amount: 11 },
      { invoiceId: 'invoice-2' },
      { paymentMethod: 'upi' },
      { transactionReference: 'receipt-2' },
      { notes: 'different notes' },
    ]) {
      await assert.rejects(invoiceService.recordPayment({ ...base, ...changed }), (error) => error.statusCode === 409);
    }
    assert.equal(mock.insertedCount, 1);
  } finally {
    pool.connect = originalConnect;
  }
});

test('different idempotency keys allow legitimate installments', async () => {
  const originalConnect = pool.connect;
  const mock = installClient();
  pool.connect = async () => mock.client;
  try {
    const common = { invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'cash' };
    const first = await invoiceService.recordPayment({ ...common, amount: 10, idempotencyKey: 'installment-key-01' });
    const second = await invoiceService.recordPayment({ ...common, amount: 15, idempotencyKey: 'installment-key-02' });
    assert.equal(first.amountPaid, 30);
    assert.equal(second.amountPaid, 45);
    assert.equal(mock.insertedCount, 2);
  } finally {
    pool.connect = originalConnect;
  }
});

test('a company cannot replay another company’s payment result using the same idempotency key', async () => {
  const originalConnect = pool.connect;
  const mock = installClient({
    invoice: { id: 'invoice-b', company_id: 'company-b', total_amount: '100.00', amount_paid: '0.00', amount_due: '100.00', job_id: null },
  });
  // Pre-seed company-a payment with the same key
  mock.persistedPayments.set('company-a:shared-key-cross-tenant', {
    invoice_id: 'invoice-a',
    payment_method: 'cash',
    transaction_reference: 'ref-a',
    amount: 50,
    notes: 'company a note',
    recorded_by: 'user-a',
    request_fingerprint: 'company-a-fingerprint',
    result_status: 'partially_paid',
    result_amount_paid: 50,
    result_amount_due: 50,
  });
  pool.connect = async () => mock.client;
  try {
    const result = await invoiceService.recordPayment({
      invoiceId: 'invoice-b',
      companyId: 'company-b',
      paymentMethod: 'cash',
      amount: 40,
      idempotencyKey: 'shared-key-cross-tenant',
    });
    // Company B did not replay Company A's 50 paid / 50 due result;
    // instead Company B's payment of 40 was recorded for invoice-b
    assert.deepEqual(result, { success: true, status: 'partially_paid', amountPaid: 40, amountDue: 60 });
    assert.equal(mock.persistedPayments.has('company-b:shared-key-cross-tenant'), true);
    assert.equal(mock.insertedCount, 1);
  } finally {
    pool.connect = originalConnect;
  }
});

test('legacy keyless payment requests preserve standard unkeyed insertion and invoice updates', async () => {
  const originalConnect = pool.connect;
  const mock = installClient();
  pool.connect = async () => mock.client;
  try {
    const result = await invoiceService.recordPayment({
      invoiceId: 'invoice-1',
      companyId: 'company-a',
      paymentMethod: 'cash',
      amount: 25,
      // No idempotencyKey provided
    });
    assert.deepEqual(result, { success: true, status: 'partially_paid', amountPaid: 45, amountDue: 55 });
    const insert = mock.calls.find(({ sql }) => sql.startsWith('INSERT INTO invoice_payments'));
    assert.ok(insert);
    assert.doesNotMatch(insert.sql, /idempotency_key/);
    assert.equal(mock.calls.some(({ sql }) => sql.startsWith('SELECT invoice_id, request_fingerprint')), false);
  } finally {
    pool.connect = originalConnect;
  }
});

test('a retry after an uncertain commit response replays the persisted outcome', async () => {
  const originalConnect = pool.connect;
  const mock = installClient({ uncertainCommit: true });
  pool.connect = async () => mock.client;
  try {
    const intent = { invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'cash', amount: 10, idempotencyKey: 'uncertain-key-01' };
    await assert.rejects(invoiceService.recordPayment(intent), (error) => error.statusCode === 500);
    const retried = await invoiceService.recordPayment(intent);
    assert.deepEqual(retried, { success: true, status: 'partially_paid', amountPaid: 30, amountDue: 70 });
    assert.equal(mock.insertedCount, 1);
  } finally {
    pool.connect = originalConnect;
  }
});

test('a simulated unique-index race replays the winner; PostgreSQL concurrency remains unverified', async () => {
  const originalConnect = pool.connect;
  const winningResult = {
    invoice_id: 'invoice-1', request_fingerprint: null,
    result_status: 'partially_paid', result_amount_paid: 31, result_amount_due: 69,
  };
  const mock = installClient({ conflictOnInsert: winningResult });
  pool.connect = async () => mock.client;
  try {
    const intent = { invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'cash', amount: 11, idempotencyKey: 'race-key-0001' };
    const crypto = require('node:crypto');
    winningResult.request_fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      companyId: 'company-a', invoiceId: 'invoice-1', amount: '11.00', paymentMethod: 'cash', transactionReference: '', notes: '',
    })).digest('hex');
    const replay = await invoiceService.recordPayment(intent);
    assert.deepEqual(replay, { success: true, status: 'partially_paid', amountPaid: 31, amountDue: 69 });
    assert.equal(mock.insertedCount, 1);
    assert.ok(mock.calls.some(({ sql }) => sql === 'ROLLBACK TO SAVEPOINT payment_idempotency_insert'));
  } finally {
    pool.connect = originalConnect;
  }
});

test('duplicate waiting behind a full payment replays before the zero-balance check', async () => {
  const originalConnect = pool.connect;
  const key = 'full-payment-race-01';
  const crypto = require('node:crypto');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    companyId: 'company-a', invoiceId: 'invoice-1', amount: '80.00', paymentMethod: 'cash',
    transactionReference: '', notes: '',
  })).digest('hex');
  const winner = {
    invoice_id: 'invoice-1',
    request_fingerprint: fingerprint,
    result_status: 'paid',
    result_amount_paid: 100,
    result_amount_due: 0,
  };
  let injected = false;
  const mock = installClient({
    afterInvoiceRead(invoice, persisted) {
      if (injected) return;
      injected = true;
      invoice.amount_paid = 100;
      invoice.amount_due = 0;
      invoice.status = 'paid';
      persisted.set('company-a:' + key, winner);
    },
  });
  pool.connect = async () => mock.client;
  try {
    const result = await invoiceService.recordPayment({
      invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'cash', amount: 80, idempotencyKey: key,
    });
    assert.deepEqual(result, { success: true, status: 'paid', amountPaid: 100, amountDue: 0 });
    assert.equal(mock.insertedCount, 0);
  } finally {
    pool.connect = originalConnect;
  }
});

test('keyed payments fail closed when the idempotency schema is absent', async () => {
  const originalConnect = pool.connect;
  const mock = installClient({ schemaMissing: true });
  pool.connect = async () => mock.client;
  try {
    await assert.rejects(
      invoiceService.recordPayment({
        invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'cash', amount: 10,
        idempotencyKey: 'schema-required-01',
      }),
      (error) => error.statusCode === 503 && error.code === 'PAYMENT_IDEMPOTENCY_SCHEMA_REQUIRED',
    );
    assert.equal(mock.calls.some(({ sql }) => sql.startsWith('SELECT * FROM invoices')), false);
    assert.equal(mock.insertedCount, 0);
    assert.ok(mock.calls.some(({ sql }) => sql === 'ROLLBACK'));
  } finally {
    pool.connect = originalConnect;
  }
});

test('keyed payment failure rolls back payment history and invoice totals together in the transaction mock', async () => {
  const originalConnect = pool.connect;
  const mock = installClient({ failUpdate: true });
  pool.connect = async () => mock.client;
  try {
    await assert.rejects(
      invoiceService.recordPayment({
        invoiceId: 'invoice-1', companyId: 'company-a', paymentMethod: 'cash', amount: 10,
        idempotencyKey: 'rollback-payment-01',
      }),
      (error) => error.statusCode === 500,
    );
    assert.equal(mock.persistedPayments.size, 0);
    assert.equal(mock.insertedCount, 1);
    assert.equal(mock.invoice.amount_paid, '20.00');
    assert.equal(mock.invoice.amount_due, '80.00');
    assert.equal(mock.calls.some(({ sql }) => sql === 'COMMIT'), false);
    assert.ok(mock.calls.some(({ sql }) => sql === 'ROLLBACK'));
  } finally {
    pool.connect = originalConnect;
  }
});

test('manual financial payment routes retain their existing authenticated-role policy', () => {
  const routeFiles = ['../routes/invoices.js', '../routes/finance.js'];
  for (const routeFile of routeFiles) {
    const source = fs.readFileSync(path.join(__dirname, routeFile), 'utf8');
    assert.doesNotMatch(source, /requireFinanceRecorder/);
    assert.match(source, /router\.post\([^\n]*record-payment|router\.post\([^\n]*payments\/record/);
    assert.match(source, /authenticate/);
  }
});

test('payment routes forward the optional standard idempotency header from the authenticated request', () => {
  for (const routeFile of ['../routes/invoices.js', '../routes/finance.js']) {
    const source = fs.readFileSync(path.join(__dirname, routeFile), 'utf8');
    assert.match(source, /idempotencyKey:\s*req\.get\(['"]Idempotency-Key['"]\)/);
  }
});

test('migration 039 is nullable and company-scoped, registered for controlled checksum-aware execution only', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '039_invoice_payment_idempotency.sql'), 'utf8');
  const autoMigrate = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'autoMigrate.js'), 'utf8');
  const { FORWARD_MIGRATIONS, STARTUP_MIGRATIONS } = require('../migrations/forwardMigrationRunner');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS idempotency_key TEXT/);
  assert.match(migration, /ON invoice_payments\(company_id, idempotency_key\)/);
  assert.match(migration, /WHERE idempotency_key IS NOT NULL/);
  assert.match(migration, /request_fingerprint/);
  assert.match(migration, /result_amount_paid/);
  assert.doesNotMatch(autoMigrate, /039_invoice_payment_idempotency\.sql/);
  assert.equal(FORWARD_MIGRATIONS.some(({ id }) => id === '039_invoice_payment_idempotency'), true);
  assert.equal(STARTUP_MIGRATIONS.some(({ id }) => id === '039_invoice_payment_idempotency'), false);
});
