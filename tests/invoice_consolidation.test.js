'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculateInvoice } = require('../services/invoiceMath');
const pdfInvoiceService = require('../services/pdfInvoiceService');
const invoiceService = require('../services/invoiceService');
const auditService = require('../services/auditService');
const billingService = require('../services/billingService');
const gstInvoiceService = require('../services/gstInvoiceService');
const { pool } = require('../db');

test('all supported invoice line item types use the same rounded subtotal and GST math', () => {
  const result = calculateInvoice({
    lineItems: [
      { item_type: 'labour', quantity: 1.5, unit_price: 100.01 },
      { item_type: 'labor', quantity: 1, unit_price: 25 },
      { item_type: 'service', quantity: 2, unit_price: 50.005 },
      { item_type: 'material', quantity: 3, unit_price: 10 },
      { item_type: 'equipment', quantity: 1, unit_price: 20 },
      { item_type: 'transport', quantity: 1, unit_price: 15 },
      { item_type: 'extra', quantity: 1, unit_price: 5 },
    ],
    equipmentCharges: 4,
    transportCharges: 6,
    additionalCharges: 7,
    discountAmount: 10,
    gstRate: 18,
  });
  assert.equal(result.itemsTotal, 345.03);
  assert.equal(result.labourCost, 175.02);
  assert.equal(result.materialsCost, 30);
  assert.equal(result.subtotal, 352.03);
  assert.equal(result.totalTax, 63.37);
  assert.equal(Number((result.cgst + result.sgst).toFixed(2)), result.totalTax);
  assert.equal(result.totalAmount, 415.4);
});
test('inter-state GST uses IGST and subtotal cannot go below zero', () => {
  const result = calculateInvoice({
    lineItems: [{ item_type: 'service', quantity: 1, unit_price: 10 }],
    discountAmount: 50,
    gstRate: 18,
    isInterState: true,
  });
  assert.equal(result.subtotal, 0);
  assert.equal(result.cgst, 0);
  assert.equal(result.sgst, 0);
  assert.equal(result.igst, 0);
  assert.equal(result.totalAmount, 0);
});

test('invalid line item quantities and amounts are rejected', () => {
  assert.throws(() => calculateInvoice({ lineItems: [{ quantity: 0, unit_price: 1 }] }), /positive quantity/);
  assert.throws(() => calculateInvoice({ lineItems: [{ quantity: 1, unit_price: -1 }] }), /non-negative unit price/);
});

test('invoice PDF output is a valid PDF document with correct xref structure', async () => {
  const pdf = await pdfInvoiceService.generateInvoicePDF(
    { invoice_number: 'INV-2026-0001', customer_name: 'Test customer', subtotal: 100, total_tax: 18, total_amount: 118 },
    [{ description: 'CNC service', quantity: 1, unit_price: 100, total_amount: 100 }],
    { name: 'Test company' }
  );
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  const source = pdf.toString('ascii');
  const xref = Number(source.match(/startxref\n(\d+)/)?.[1]);
  assert.ok(Number.isInteger(xref));
  assert.equal(source.slice(xref, xref + 4), 'xref');
  assert.match(source, /Invoice: INV-2026-0001/);
});

test('PDF generator paginates larger invoices', async () => {
  const pdf = await pdfInvoiceService.generateInvoicePDF(
    { invoice_number: 'INV-LONG', total_amount: 1 },
    Array.from({ length: 45 }, (_, index) => ({ description: `Item ${index}`, quantity: 1, unit_price: 1, total_amount: 1 }))
  );
  assert.ok((pdf.toString('ascii').match(/\/Type \/Page /g) || []).length > 1);
});

test('legacy billing entry point delegates draft creation to the canonical invoice service', async () => {
  const original = invoiceService.createJobDraft;
  invoiceService.createJobDraft = async (args) => ({ delegated: true, ...args });
  try {
    const result = await billingService.generateInvoice('job-1', 'company-1', 'owner-1');
    assert.deepEqual(result, { delegated: true, companyId: 'company-1', jobId: 'job-1', userId: 'owner-1' });
  } finally {
    invoiceService.createJobDraft = original;
  }
});

test('legacy GST invoice entry point delegates persistence to the canonical direct invoice engine', async () => {
  const original = invoiceService.createDirectInvoice;
  invoiceService.createDirectInvoice = async ({ companyId, userId, invoiceData }) => ({
    invoice: { id: 'invoice-1', invoice_number: 'INV-2026-0002', customer_name: invoiceData.customer_name,
      customer_gstin: invoiceData.customer_gstin, created_at: new Date().toISOString(), due_date: null,
      is_inter_state: true, subtotal: 100, cgst: 0, sgst: 0, igst: 18, total_tax: 18,
      total_amount: 118 },
    lineItems: invoiceData.lineItems,
  });
  try {
    const result = await gstInvoiceService.generateGSTInvoice({
      companyId: 'company-1', customerName: 'Client', customerGstin: 'GSTIN', isInterState: true,
      items: [{ description: 'Service', quantity: 1, unitPrice: 100 }],
    });
    assert.equal(result.invoice.invoiceNumber, 'INV-2026-0002');
    assert.equal(result.invoice.grandTotal, '118.00');
    assert.equal(result.invoice.igst, '18.00');
  } finally {
    invoiceService.createDirectInvoice = original;
  }
});

test('invoice number allocator locks the tenant row and increments the highest canonical number', async () => {
  const queries = [];
  const fakeClient = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (sql.includes('FROM companies')) return { rows: [{ id: 7 }] };
    if (sql.includes('FROM invoices')) return { rows: [{ invoice_number: `INV-${new Date().getFullYear()}-0009` }, { invoice_number: 'legacy-number' }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const result = await invoiceService.allocateInvoiceNumber(fakeClient, 7);
  assert.equal(result, `INV-${new Date().getFullYear()}-0010`);
  assert.match(queries[0].sql, /FOR UPDATE/);
  assert.deepEqual(queries[0].values, ['7']);
});

test('editor material request query is scoped to both the selected job and company', async () => {
  const originalQuery = pool.query;
  const seen = [];
  pool.query = async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes('FROM jobs')) return { rows: [{ id: 'job-2', company_id: 'company-2', status: 'completed', started_at: null, completed_at: null, customer_name: 'Client' }] };
    if (sql.includes('FROM company_settings')) return { rows: [] };
    if (sql.includes('FROM material_requests')) return { rows: [] };
    if (sql.includes('FROM invoices')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    await invoiceService.prepareInvoiceDataForJob('job-2', 'company-2');
    const materialQuery = seen.find((item) => item.sql.includes('FROM material_requests'));
    assert.match(materialQuery.sql, /company_id::text = \$1::text AND job_id::text = \$2::text/);
    assert.deepEqual(materialQuery.params, ['company-2', 'job-2']);
  } finally {
    pool.query = originalQuery;
  }
});

test('cross-company job lookup is denied before invoice preparation', async () => {
  const originalQuery = pool.query;
  const seen = [];
  pool.query = async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes('FROM jobs')) return { rows: [] };
    if (sql.includes('FROM invoices')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    await assert.rejects(invoiceService.prepareInvoiceDataForJob('other-job', 'company-a'), /not found/);
    assert.match(seen[0].sql, /company_id::text = \$2::text/);
    assert.deepEqual(seen[0].params, ['other-job', 'company-a']);
  } finally {
    pool.query = originalQuery;
  }
});

test('customer sign-off cannot insert or issue invoices, and job completion does not auto-create drafts', () => {
  const proofRoute = fs.readFileSync(path.join(__dirname, '../routes/proofOfWork.js'), 'utf8');
  const jobsRoute = fs.readFileSync(path.join(__dirname, '../routes/jobs.js'), 'utf8');
  assert.doesNotMatch(proofRoute, /INSERT\s+INTO\s+invoices/i);
  assert.doesNotMatch(jobsRoute, /generateInvoice\(updatedJob\.id/);
});

test('completed job issuance creates one invoice linked to the selected company, job, and customer', async () => {
  const originalConnect = pool.connect;
  const originalAudit = auditService.log;
  const executed = [];
  let insertedInvoice;
  const client = { query: async (sql, params = []) => {
    executed.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM jobs j')) return { rows: [{ id: 'job-1', company_id: 'company-1', customer_id: 'customer-1', status: 'completed', title: 'Repair', customer_name: 'Client', customer_email: 'client@example.test', customer_phone: '123' }] };
    if (sql.includes('SELECT id, invoice_number, edited_count')) return { rows: [] };
    if (sql.includes('FROM companies')) return { rows: [{ id: 'company-1' }] };
    if (sql.includes('SELECT invoice_number FROM invoices')) return { rows: [] };
    if (sql.includes('INSERT INTO invoices')) {
      insertedInvoice = { id: 'invoice-1', company_id: params[0], job_id: params[1], customer_id: params[2], invoice_number: params[6], status: 'issued', total_amount: params[22], amount_due: params[22] };
      return { rows: [insertedInvoice] };
    }
    if (sql.includes('UPDATE invoices SET pdf_url')) return { rows: [] };
    return { rows: [] };
  }, release() {} };
  pool.connect = async () => client;
  auditService.log = async () => {};
  try {
    const result = await invoiceService.finalizeInvoice({ companyId: 'company-1', jobId: 'job-1', userId: 'owner-1', invoiceData: {
      idempotency_key: 'job-invoice-key-1',
      lineItems: [{ item_type: 'labour', description: 'Repair labor', quantity: 2, unit_price: 100 }],
      gst_rate: 18, due_days: 15,
    } });
    assert.equal(result.success, true);
    assert.equal(insertedInvoice.company_id, 'company-1');
    assert.equal(insertedInvoice.job_id, 'job-1');
    assert.equal(insertedInvoice.customer_id, 'customer-1');
    assert.equal(insertedInvoice.total_amount, 236);
    assert.equal(executed.filter((entry) => entry.sql.includes('INSERT INTO invoices')).length, 1);
    assert.ok(executed.some((entry) => entry.sql.includes('INSERT INTO ar_collection_schedules')));
    assert.ok(executed.some((entry) => entry.sql.includes('INSERT INTO invoice_items')));
    assert.ok(executed.some((entry) => entry.sql === 'COMMIT'));
  } finally {
    pool.connect = originalConnect;
    auditService.log = originalAudit;
  }
});

test('finalizing a draft updates its PDF reference and AR schedule in the same transaction', async () => {
  const originalConnect = pool.connect;
  const executed = [];
  const client = { query: async (sql, params = []) => {
    executed.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM jobs j')) return { rows: [{ id: 'job-2', company_id: 'company-1', customer_id: 'customer-2', status: 'completed', title: 'Service', customer_name: 'Client' }] };
    if (sql.includes('SELECT id, invoice_number, edited_count')) return { rows: [{ id: 'draft-1', invoice_number: 'INV-2026-0002', edited_count: 0, status: 'draft', amount_paid: 0 }] };
    if (sql.includes('UPDATE invoices SET')) return { rows: [{ id: 'draft-1', invoice_number: 'INV-2026-0002', status: 'issued', customer_name: 'Client', total_amount: 118, amount_paid: 0, amount_due: 118, edited_count: 1 }] };
    return { rows: [] };
  }, release() {} };
  pool.connect = async () => client;
  try {
    const result = await invoiceService.finalizeInvoice({ companyId: 'company-1', jobId: 'job-2', userId: 'owner-1', invoiceData: {
      idempotency_key: 'job-invoice-key-2',
      lineItems: [{ item_type: 'service', description: 'Repair', quantity: 1, unit_price: 100 }], gst_rate: 18,
    } });
    assert.equal(result.invoice.id, 'draft-1');
    assert.ok(executed.some((entry) => entry.sql.includes("status = 'issued'") && entry.sql.includes('pdf_url = $26')));
    assert.ok(executed.some((entry) => entry.sql.includes('INSERT INTO ar_collection_schedules') && entry.sql.includes('ON CONFLICT')));
    assert.equal(executed.filter((entry) => entry.sql.includes('INSERT INTO invoices')).length, 0);
    assert.equal(executed.filter((entry) => entry.sql === 'COMMIT').length, 1);
  } finally {
    pool.connect = originalConnect;
  }
});

test('an already-issued or paid invoice is not rewritten during editor finalization', async () => {
  const originalConnect = pool.connect;
  const executed = [];
  const client = { query: async (sql) => {
    executed.push(sql);
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM jobs j')) return { rows: [{ id: 'job-3', company_id: 'company-1', status: 'completed', customer_name: 'Client' }] };
    if (sql.includes('SELECT id, invoice_number, edited_count')) return { rows: [{ id: 'paid-1', status: 'paid', amount_paid: 118 }] };
    return { rows: [] };
  }, release() {} };
  pool.connect = async () => client;
  try {
    await assert.rejects(invoiceService.finalizeInvoice({ companyId: 'company-1', jobId: 'job-3', invoiceData: { idempotency_key: 'job-invoice-key-3', lineItems: [] } }), (error) => error.statusCode === 409);
    assert.equal(executed.some((sql) => sql.startsWith('UPDATE invoices')), false);
    assert.equal(executed.includes('ROLLBACK'), true);
  } finally {
    pool.connect = originalConnect;
  }
});

test('direct invoice idempotency replay returns the first invoice without a second stock movement', async () => {
  const originalConnect = pool.connect;
  const executed = [];
  const prior = { id: 'direct-1', company_id: 'company-1', job_id: null, idempotency_key: 'key-1', pdf_url: '/api/invoices/direct-1/pdf' };
  const client = { query: async (sql) => {
    executed.push(sql);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('idempotency_key')) return { rows: [prior] };
    if (sql.includes('FROM invoice_items')) return { rows: [{ description: 'Service' }] };
    return { rows: [] };
  }, release() {} };
  pool.connect = async () => client;
  try {
    const result = await invoiceService.createDirectInvoice({ companyId: 'company-1', invoiceData: { idempotency_key: 'key-1' } });
    assert.equal(result.invoice.id, 'direct-1');
    assert.equal(result.invoice.job_id, null);
    assert.equal(result.idempotentReplay, true);
    assert.equal(executed.some((sql) => sql.includes('UPDATE inventory_items')), false);
    assert.equal(executed.filter((sql) => sql.includes('INSERT INTO invoices')).length, 0);
  } finally {
    pool.connect = originalConnect;
  }
});
