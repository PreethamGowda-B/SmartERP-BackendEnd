'use strict';

process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_mock_key_12345';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-1234567890';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Domain Services & Route Handlers
const invoiceService = require('../services/invoiceService');
const {
  createFinancePaymentsReadHandler,
  createFinancePaymentRecordHandler,
} = require('../routes/finance');
const {
  createInvoicePaymentRecordHandler,
} = require('../routes/invoices');
const {
  createWorkRequestSubmitHandler,
  createWorkRequestListHandler,
  canTransitionWorkRequest,
} = require('../routes/workRequests');
const {
  createPurchaseOrderHandler,
  createVendorReadHandler,
} = require('../routes/cncVendors');
const {
  createWarrantyClaimsReadHandler,
  createWarrantyClaimResolveHandler,
  canTransitionWarrantyClaim: canTransitionWarranty,
} = require('../routes/warrantyClaims');
const { pool } = require('../db');

function mockResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

// ─── TASK A2: Financial API Role Authorization Tests ────────────────────────

test('Finance payments GET rejects non-admin/non-owner roles with 403', async () => {
  const handler = createFinancePaymentsReadHandler();
  const req = {
    user: { id: 'emp-1', companyId: 'comp-1', role: 'employee' },
  };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Only owners or administrators/);
});

test('Finance payment record POST rejects non-admin/non-owner roles with 403', async () => {
  const handler = createFinancePaymentRecordHandler();
  const req = {
    user: { id: 'emp-1', companyId: 'comp-1', role: 'employee' },
    body: { invoiceId: 'inv-1', paymentMethod: 'cash', amount: 100 },
    get: () => null,
  };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Only owners or administrators/);
});

test('Invoice payment record POST rejects unauthorized role with 403', async () => {
  const handler = createInvoicePaymentRecordHandler();
  const req = {
    user: { id: 'emp-1', companyId: 'comp-1', role: 'technician' },
    params: { id: 'inv-1' },
    body: { paymentMethod: 'cash', amount: 100 },
    get: () => null,
  };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Only owners or administrators/);
});

test('Finance payments GET joins invoice within matching company', async () => {
  let executedSql = '';
  const mockQuery = async (sql) => {
    executedSql = sql;
    return { rows: [{ id: 'pay-1', amount: 50, invoice_number: 'INV-001' }] };
  };
  const handler = createFinancePaymentsReadHandler(mockQuery);
  const req = {
    user: { id: 'owner-1', companyId: 'comp-100', role: 'owner' },
  };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(executedSql.includes('p.company_id = i.company_id'), 'Join must enforce same company predicate');
});

// ─── TASK A3: Accounts-Receivable Consistency Tests ─────────────────────────

test('recordPayment updates AR schedule amount_outstanding on partial installment', async () => {
  const originalConnect = pool.connect;
  const calls = [];
  const mockClient = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM invoices WHERE id = $1')) {
        return {
          rows: [{
            id: 'inv-1',
            company_id: 'comp-1',
            total_amount: '100.00',
            amount_paid: '0.00',
            amount_due: '100.00',
            status: 'unpaid',
            job_id: null,
          }],
        };
      }
      if (sql.includes('UPDATE invoices')) {
        return { rows: [{ id: 'inv-1' }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  pool.connect = async () => mockClient;

  try {
    const result = await invoiceService.recordPayment({
      invoiceId: 'inv-1',
      companyId: 'comp-1',
      paymentMethod: 'cash',
      amount: 40.0,
      notes: 'Partial payment',
    });

    assert.equal(result.status, 'partially_paid');
    assert.equal(result.amountPaid, 40);
    assert.equal(result.amountDue, 60);

    // Verify AR schedule update
    const arUpdate = calls.find(({ sql }) => sql.includes('UPDATE ar_collection_schedules'));
    assert.ok(arUpdate, 'Must update ar_collection_schedules on partial payment');
    assert.match(arUpdate.sql, /amount_outstanding = \$1/);
    assert.equal(arUpdate.params[0], 60);
    assert.equal(arUpdate.params[1], 'inv-1');
    assert.equal(arUpdate.params[2], 'comp-1');
  } finally {
    pool.connect = originalConnect;
  }
});

test('recordPayment settles AR schedule on full payment in the same transaction', async () => {
  const originalConnect = pool.connect;
  const calls = [];
  const mockClient = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM invoices WHERE id = $1')) {
        return {
          rows: [{
            id: 'inv-1',
            company_id: 'comp-1',
            total_amount: '100.00',
            amount_paid: '60.00',
            amount_due: '40.00',
            status: 'partially_paid',
            job_id: 'job-1',
          }],
        };
      }
      if (sql.includes('UPDATE invoices')) {
        return { rows: [{ id: 'inv-1' }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  pool.connect = async () => mockClient;

  try {
    const result = await invoiceService.recordPayment({
      invoiceId: 'inv-1',
      companyId: 'comp-1',
      paymentMethod: 'cash',
      amount: 40.0,
      notes: 'Final installment',
    });

    assert.equal(result.status, 'paid');
    assert.equal(result.amountPaid, 100);
    assert.equal(result.amountDue, 0);

    const arSettled = calls.find(({ sql }) => sql.includes("current_stage = 'settled'"));
    assert.ok(arSettled, 'AR schedule must be marked settled when fully paid');
    assert.ok(calls.some(({ sql }) => sql === 'COMMIT'), 'Must commit transaction');
  } finally {
    pool.connect = originalConnect;
  }
});

// ─── TASK A4: Direct-Invoice Idempotency Fingerprint Tests ───────────────────

test('createDirectInvoice rejects repeated key with changed customer or items with 409', async () => {
  const originalConnect = pool.connect;
  const mockClient = {
    query: async (sql, params = []) => {
      if (sql.includes('SELECT * FROM invoices WHERE company_id::text = $1::text AND idempotency_key = $2')) {
        return {
          rows: [{
            id: 'inv-direct-1',
            company_id: 'comp-1',
            request_fingerprint: 'a'.repeat(64),
            customer_id: 'cust-1',
            customer_name: 'Original Customer',
            customer_email: 'orig@test.com',
            discount_amount: '0.00',
            is_inter_state: false,
            status: 'issued',
            payment_method: null,
            pdf_url: null,
          }],
        };
      }
      if (sql.includes('SELECT * FROM invoice_items WHERE invoice_id = $1')) {
        return {
          rows: [{
            id: 'item-1',
            item_type: 'service',
            description: 'Original Service',
            quantity: 1,
            unit_price: 100,
            total_amount: 100,
          }],
        };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  pool.connect = async () => mockClient;

  try {
    await assert.rejects(
      async () => {
        await invoiceService.createDirectInvoice({
          companyId: 'comp-1',
          userId: 'user-1',
          invoiceData: {
            idempotency_key: 'direct-key-001',
            customer_name: 'DIFFERENT Customer',
            lineItems: [{ description: 'New Different Item', unit_price: 500, quantity: 2 }],
          },
        });
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /already used for a direct invoice with different details/);
        return true;
      }
    );
  } finally {
    pool.connect = originalConnect;
  }
});

test('createDirectInvoice replays committed invoice when same key and same items are re-submitted', async () => {
  const originalConnect = pool.connect;
  const mockClient = {
    query: async (sql, params = []) => {
      if (sql.includes('SELECT * FROM invoices WHERE company_id::text = $1::text AND idempotency_key = $2')) {
        return {
          rows: [{
            id: 'inv-direct-1',
            company_id: 'comp-1',
            request_fingerprint: invoiceService.directInvoiceFingerprint('comp-1', {
              idempotency_key: 'direct-key-001',
              customer_name: 'Walk-in Customer',
              lineItems: [{ description: 'Standard Repair', unit_price: 100, quantity: 1 }],
            }),
            customer_id: null,
            customer_name: 'Walk-in Customer',
            customer_email: '',
            discount_amount: '0.00',
            is_inter_state: false,
            status: 'issued',
            payment_method: null,
            pdf_url: '/invoices/inv-1.pdf',
          }],
        };
      }
      if (sql.includes('SELECT * FROM invoice_items WHERE invoice_id = $1')) {
        return {
          rows: [{
            id: 'item-1',
            item_type: 'service',
            description: 'Standard Repair',
            quantity: 1,
            unit_price: 100,
            total_amount: 100,
          }],
        };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  pool.connect = async () => mockClient;

  try {
    const replay = await invoiceService.createDirectInvoice({
      companyId: 'comp-1',
      userId: 'user-1',
      invoiceData: {
        idempotency_key: 'direct-key-001',
        customer_name: 'Walk-in Customer',
        lineItems: [{ description: 'Standard Repair', unit_price: 100, quantity: 1 }],
      },
    });

    assert.equal(replay.success, true);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.invoice.id, 'inv-direct-1');
  } finally {
    pool.connect = originalConnect;
  }
});

// ─── TASK A5: Work-Request Linked Object Validation & Data Minimization ──────

test('POST /api/work-requests rejects foreign or missing linked job with 404', async () => {
  const mockDb = {
    query: async (sql) => {
      if (sql.includes('SELECT id FROM jobs WHERE')) {
        return { rows: [] }; // Foreign/missing job
      }
      return { rows: [] };
    },
  };
  const handler = createWorkRequestSubmitHandler({
    db: mockDb,
    ensureSchema: async () => {},
  });

  const req = {
    user: { id: 'emp-1', companyId: 'comp-1', role: 'employee' },
    body: {
      request_type: 'additional_worker',
      title: 'Need helper',
      job_id: 'job-999-foreign',
    },
  };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.message, /linked job was not found for this company/);
});

test('GET /api/work-requests restricts employee to their own submitted requests', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const mockDb = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    },
  };
  const handler = createWorkRequestListHandler({
    db: mockDb,
    ensureSchema: async () => {},
  });

  const req = {
    user: { id: 'emp-42', companyId: 'comp-1', role: 'employee' },
    query: {},
  };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(capturedSql.includes('r.submitted_by_id::text'), 'Employee must be restricted to their own submitted_by_id');
  assert.ok(capturedParams.includes('emp-42'));
});

// ─── TASK A6: CNC Purchase Order Role Access & Collision Safety ─────────────

test('CNC purchase order creation rejects employee role with 403', async () => {
  const handler = createPurchaseOrderHandler();
  const req = {
    user: { id: 'emp-1', companyId: 'comp-1', role: 'employee' },
    body: { vendor_name: 'Vendor X', parts_description: 'Spindle', total_cost: 1000 },
  };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Only company owners or administrators/);
});

test('CNC purchase order creates collision-resistant PO number with random entropy', async () => {
  let insertedPo = null;
  const mockQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO purchase_orders')) {
      insertedPo = params[1]; // po_number is 2nd param
      return {
        rows: [{
          id: 'po-1',
          po_number: insertedPo,
          vendor_name: params[2],
          parts_description: params[4],
          total_cost: params[5],
          status: 'issued',
          created_at: new Date(),
        }],
      };
    }
    return { rows: [] };
  };

  const handler = createPurchaseOrderHandler(mockQuery);
  const req = {
    user: { id: 'owner-1', companyId: 'comp-1', role: 'owner' },
    body: { vendor_name: 'Vendor A', parts_description: 'Shaft 10mm', total_cost: 2500 },
  };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 201);
  assert.ok(insertedPo, 'PO number must be generated');
  assert.match(insertedPo, /^PO-\d{6}-[0-9A-F]{4}$/, 'PO number must contain timestamp slice and 4 hex chars entropy');
});

// ─── TASK A7: CNC Warranty Claims Review & Timeline Integrity ───────────────

test('CNC warranty claims resolve rejects employee role with 403', async () => {
  const handler = createWarrantyClaimResolveHandler();
  const req = {
    user: { id: 'emp-1', companyId: 'comp-1', role: 'employee' },
    params: { id: 'claim-1' },
    body: { status: 'approved', credit_amount: 500 },
  };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Only owners or administrators/);
});

test('CNC warranty claims resolve records timeline note without finance credit note', async () => {
  const mockClient = {
    query: async (sql, params = []) => {
      if (sql.includes('SELECT * FROM warranty_claims')) {
        return {
          rows: [{
            id: 'claim-1',
            claim_number: 'WC-001',
            company_id: 'comp-1',
            machine_id: 'mach-1',
            status: 'submitted',
          }],
        };
      }
      if (sql.includes('UPDATE warranty_claims')) {
        return {
          rows: [{
            id: 'claim-1',
            claim_number: 'WC-001',
            company_id: 'comp-1',
            machine_id: 'mach-1',
            status: 'approved',
            supplier_credit_amount: 1500,
          }],
        };
      }
      if (sql.includes('INSERT INTO machine_timeline_events')) {
        assert.match(params[3], /Supplier credit amount recorded: ₹1500\.00; no finance credit note was issued/);
        return { rows: [{ id: 'event-1' }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };

  const mockDb = {
    connect: async () => mockClient,
  };

  const handler = createWarrantyClaimResolveHandler(mockDb);
  const req = {
    user: { id: 'owner-1', companyId: 'comp-1', role: 'owner' },
    params: { id: 'claim-1' },
    body: { status: 'approved', credit_amount: 1500 },
  };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.claim.status, 'approved');
});
