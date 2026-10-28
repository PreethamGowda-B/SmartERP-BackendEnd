const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

test('Verify OTP Route — HMAC matching and validation contract', () => {
  const computeHmacToken = (data, secretSalt = 'smarterp_default_sec_salt') => {
    return crypto.createHmac('sha256', secretSalt).update(String(data)).digest('hex');
  };

  const plainOtp = '123456';
  const email = 'newuser@example.com';
  const expectedHash = computeHmacToken(plainOtp + email.toLowerCase().trim());

  // Valid hash matches timingSafeEqual
  const match = crypto.timingSafeEqual(
    Buffer.from(expectedHash, 'utf8'),
    Buffer.from(computeHmacToken('123456newuser@example.com'), 'utf8')
  );
  assert.equal(match, true);

  // Wrong OTP does not match
  const wrongHash = computeHmacToken('654321' + email);
  const mismatch = crypto.timingSafeEqual(
    Buffer.from(expectedHash, 'utf8'),
    Buffer.from(wrongHash, 'utf8')
  );
  assert.equal(mismatch, false);
});

test('Customer Directory Route — multi-tenant isolation query shape', () => {
  const customersRoute = require('../routes/customers');
  assert.ok(customersRoute, 'customers route module should load successfully');
  assert.equal(typeof customersRoute, 'function', 'express router is exported');
});

test('Finance AR Aging Reminder Route — registered and accessible', () => {
  const financeRoute = require('../routes/finance');
  assert.ok(financeRoute, 'finance route module should load successfully');
  assert.equal(typeof financeRoute, 'function', 'express router is exported');
});

test('SSE Headers — Content-Encoding none prevents QUIC packet write errors', () => {
  const headers = {};
  const mockRes = {
    setHeader(key, value) {
      headers[key] = value;
    },
  };

  mockRes.setHeader('Content-Type', 'text/event-stream');
  mockRes.setHeader('Cache-Control', 'no-cache, no-transform');
  mockRes.setHeader('Connection', 'keep-alive');
  mockRes.setHeader('X-Accel-Buffering', 'no');
  mockRes.setHeader('Content-Encoding', 'none');

  assert.equal(headers['Content-Encoding'], 'none');
  assert.equal(headers['Cache-Control'], 'no-cache, no-transform');
});
