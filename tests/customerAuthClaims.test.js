const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'isolated-customer-auth-test-secret';

const { authenticateCustomer } = require('../middleware/customerAuthMiddleware');
const { storage } = require('../middleware/als');

function authenticate(payload) {
  return new Promise((resolve, reject) => {
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1m' });
    const req = { cookies: { customer_access_token: token }, headers: {} };
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); },
    };

    authenticateCustomer(req, response, () => {
      resolve({ customer: req.customer, tenant: storage.getStore() });
    });
    setTimeout(() => reject(new Error('Customer authentication callback timed out')), 1000).unref();
  });
}

test('customer auth normalizes legacy identity and company claims for customer routes', async () => {
  const result = await authenticate({ customerId: 'customer-42', role: 'customer', company_id: 'company-9' });
  assert.equal(result.customer.id, 'customer-42');
  assert.equal(result.customer.companyId, 'company-9');
  assert.equal(result.tenant.userId, 'customer-42');
  assert.equal(result.tenant.companyId, 'company-9');
  assert.equal(result.tenant.role, 'customer');
});

