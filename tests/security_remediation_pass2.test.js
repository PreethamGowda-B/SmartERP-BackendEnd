const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

// Ensure JWT_SECRET for test
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-1234567890-secure';

// Require routes to test
const customerDocumentsRouter = require('../routes/customer/documents');
const customerMachinesRouter = require('../routes/customer/machines');
const proofOfWorkRouter = require('../routes/proofOfWork');
const workRequestsRouter = require('../routes/workRequests');
const warrantyClaimsRouter = require('../routes/warrantyClaims');
const feedbackRouter = require('../routes/feedback');
const enterpriseSearchRouter = require('../routes/enterpriseSearch');
const customerReportsRouter = require('../routes/customerReports');
const quotationsRouter = require('../routes/quotations');

// Helper to sign test tokens
function createToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('SmartERP Security Remediation — Pass 2 Regression Suite', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.use(express.json());

    // Mount customer portal submodules with mock authenticateCustomer
    app.use('/api/customer/documents', (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
          req.customer = decoded;
        } catch (err) {
          return res.status(401).json({ error: 'Invalid token' });
        }
      }
      customerDocumentsRouter(req, res, next);
    });

    app.use('/api/customer/machines', (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
          req.customer = decoded;
        } catch (err) {
          return res.status(401).json({ error: 'Invalid token' });
        }
      }
      customerMachinesRouter(req, res, next);
    });

    // Mount standard routes
    app.use('/api/jobs', proofOfWorkRouter);
    app.use('/api/work-requests', workRequestsRouter);
    app.use('/api/warranty-claims', warrantyClaimsRouter);
    app.use('/api/feedback', feedbackRouter);
    app.use('/api/search', enterpriseSearchRouter);
    app.use('/api/customer-reports', customerReportsRouter);
    app.use('/api/quotations', quotationsRouter);

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const tokenCompanyA_Owner = createToken({ userId: '1001', id: '1001', role: 'owner', companyId: 1001, company_id: 1001 });
  const tokenCompanyA_Employee = createToken({ userId: '1002', id: '1002', role: 'employee', companyId: 1001, company_id: 1001 });
  const tokenCompanyA_CustA = createToken({ id: '2001', userId: '2001', role: 'customer', companyId: 1001, company_id: 1001 });
  const tokenNoCompany = createToken({ userId: '9999', id: '9999', role: 'owner' });

  // -------------------------------------------------------------------------
  // P0 #1: Customer Documents Isolation
  // -------------------------------------------------------------------------
  test('P0 #1: GET /api/customer/documents rejects unauthenticated callers', async () => {
    const res = await fetch(`${baseUrl}/api/customer/documents`);
    assert.equal(res.status, 401);
  });

  test('P0 #1: GET /api/customer/documents succeeds with customer credentials and returns array', async () => {
    const res = await fetch(`${baseUrl}/api/customer/documents`, {
      headers: { Authorization: `Bearer ${tokenCompanyA_CustA}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.documents));
  });

  // -------------------------------------------------------------------------
  // P0 #2: Customer Machines Isolation
  // -------------------------------------------------------------------------
  test('P0 #2: GET /api/customer/machines rejects unauthenticated callers', async () => {
    const res = await fetch(`${baseUrl}/api/customer/machines`);
    assert.equal(res.status, 401);
  });

  test('P0 #2: GET /api/customer/machines/:id rejects access when machine does not match customer/company', async () => {
    const res = await fetch(`${baseUrl}/api/customer/machines/non-existent-or-unauthorized-id`, {
      headers: { Authorization: `Bearer ${tokenCompanyA_CustA}` }
    });
    assert.equal(res.status, 404);
  });

  // -------------------------------------------------------------------------
  // P0 #3: Proof-of-Work Retrieval & Customer Sign-off
  // -------------------------------------------------------------------------
  test('P0 #3: GET /api/jobs/:id/proof-of-work rejects unauthenticated access', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/job-123/proof-of-work`);
    assert.equal(res.status, 401);
  });

  test('P0 #3: POST /api/jobs/:id/customer-signoff rejects unauthenticated callers', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/job-123/customer-signoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature_url: 'https://example.com/sig.png' })
    });
    assert.equal(res.status, 401);
  });

  test('P0 #3: POST /api/jobs/:id/customer-signoff rejects missing digital signature', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/job-123/customer-signoff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenCompanyA_CustA}`
      },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });

  // -------------------------------------------------------------------------
  // P1 #4: Work Request RBAC & Tenant Isolation
  // -------------------------------------------------------------------------
  test('P1 #4: POST /api/work-requests/:id/action rejects employee role (RBAC)', async () => {
    const res = await fetch(`${baseUrl}/api/work-requests/req-123/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenCompanyA_Employee}`
      },
      body: JSON.stringify({ action: 'approve' })
    });
    assert.equal(res.status, 403);
  });

  test('P1 #4: POST /api/work-requests/:id/action allows owner role but returns 404 for missing request', async () => {
    const res = await fetch(`${baseUrl}/api/work-requests/non-existent-req/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenCompanyA_Owner}`
      },
      body: JSON.stringify({ action: 'approve' })
    });
    assert.equal(res.status, 404);
  });

  // -------------------------------------------------------------------------
  // P1 #5: Warranty Claims Tenant Isolation & Resolution RBAC
  // -------------------------------------------------------------------------
  test('P1 #5: GET /api/warranty-claims rejects missing company context', async () => {
    const res = await fetch(`${baseUrl}/api/warranty-claims`, {
      headers: { Authorization: `Bearer ${tokenNoCompany}` }
    });
    assert.equal(res.status, 401);
  });

  test('P1 #5: POST /api/warranty-claims/:id/resolve rejects employee role (RBAC)', async () => {
    const res = await fetch(`${baseUrl}/api/warranty-claims/wc-123/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenCompanyA_Employee}`
      },
      body: JSON.stringify({ status: 'approved', credit_amount: 500 })
    });
    assert.equal(res.status, 403);
  });

  // -------------------------------------------------------------------------
  // P1 #6: Feedback Tenant Isolation
  // -------------------------------------------------------------------------
  test('P1 #6: PATCH /api/feedback/:id/status rejects unauthorized employee role', async () => {
    const res = await fetch(`${baseUrl}/api/feedback/fb-123/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenCompanyA_Employee}`
      },
      body: JSON.stringify({ status: 'resolved' })
    });
    assert.equal(res.status, 403);
  });

  test('P1 #6: PATCH /api/feedback/:id/status validates status enum', async () => {
    const res = await fetch(`${baseUrl}/api/feedback/fb-123/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenCompanyA_Owner}`
      },
      body: JSON.stringify({ status: 'invalid_status_xyz' })
    });
    assert.equal(res.status, 400);
  });

  // -------------------------------------------------------------------------
  // P2 #7: Global Search Tenant Isolation
  // -------------------------------------------------------------------------
  test('P2 #7: GET /api/search/global rejects missing company context', async () => {
    const res = await fetch(`${baseUrl}/api/search/global?q=drill`, {
      headers: { Authorization: `Bearer ${tokenNoCompany}` }
    });
    assert.equal(res.status, 401);
  });

  test('P2 #7: GET /api/search/global returns empty on short query string', async () => {
    const res = await fetch(`${baseUrl}/api/search/global?q=a`, {
      headers: { Authorization: `Bearer ${tokenCompanyA_Owner}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.results, []);
  });

  // -------------------------------------------------------------------------
  // P2 #8: Customer Reports RBAC
  // -------------------------------------------------------------------------
  test('P2 #8: GET /api/customer-reports rejects employee role', async () => {
    const res = await fetch(`${baseUrl}/api/customer-reports`, {
      headers: { Authorization: `Bearer ${tokenCompanyA_Employee}` }
    });
    assert.equal(res.status, 403);
  });

  test('P2 #8: GET /api/customer-reports rejects missing company context', async () => {
    const res = await fetch(`${baseUrl}/api/customer-reports`, {
      headers: { Authorization: `Bearer ${tokenNoCompany}` }
    });
    assert.equal(res.status, 401);
  });

  test('P2 #8: GET /api/customer-reports allows owner role', async () => {
    const res = await fetch(`${baseUrl}/api/customer-reports`, {
      headers: { Authorization: `Bearer ${tokenCompanyA_Owner}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.analytics);
  });

  // -------------------------------------------------------------------------
  // P3 #9: Quotation Revision Defense-in-Depth
  // -------------------------------------------------------------------------
  test('P3 #9: POST /api/quotations/:id/revise rejects missing company context', async () => {
    const res = await fetch(`${baseUrl}/api/quotations/qt-123/revise`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenNoCompany}`
      },
      body: JSON.stringify({ title: 'Revised' })
    });
    assert.equal(res.status, 401);
  });

  test('P3 #9: POST /api/quotations/:id/revise returns 404 for non-existent or foreign quotation', async () => {
    const res = await fetch(`${baseUrl}/api/quotations/foreign-qt-999/revise`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenCompanyA_Owner}`
      },
      body: JSON.stringify({ title: 'Revised Estimate', labor_amount: 1000 })
    });
    assert.equal(res.status, 404);
  });
});
