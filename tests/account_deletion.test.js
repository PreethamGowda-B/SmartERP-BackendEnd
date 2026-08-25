const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-1234567890-secure';

const { pool } = require('../db');
const accountRouter = require('../routes/account');
const customerProfileRouter = require('../routes/customer/profile');

function createStaffToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function createCustomerToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('SmartERP Secure Account Deletion & Data Erasure Test Suite', () => {
  let server;
  let baseUrl;

  // Test Entities
  let testCompanyId;
  let testOwnerId;
  let testAdminId;
  let testEmployeeId;
  let testSoleOwnerCompId;
  let testSoleOwnerId;
  let testCustomerId;

  let tokenEmployee;
  let tokenSoleOwner;
  let tokenMultiOwner;
  let tokenCustomer;

  before(async () => {
    // Setup Express Test App
    const app = express();
    app.use(express.json());

    // Middleware to set req.user from Bearer token
    app.use('/api/account', (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
          req.user = decoded;
        } catch (err) {
          return res.status(401).json({ error: 'Invalid token' });
        }
      }
      accountRouter(req, res, next);
    });

    // Middleware to set req.customer from Bearer token
    app.use('/api/customer/profile', (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
          req.customer = decoded;
        } catch (err) {
          return res.status(401).json({ error: 'Invalid token' });
        }
      }
      customerProfileRouter(req, res, next);
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Ensure migration 024 columns & tables exist
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

      ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

      CREATE TABLE IF NOT EXISTS account_deletion_audit (
          id SERIAL PRIMARY KEY,
          account_type VARCHAR(50) NOT NULL,
          original_user_id VARCHAR(255) NOT NULL,
          company_id VARCHAR(255),
          role VARCHAR(50),
          deletion_timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          ip_address VARCHAR(100),
          user_agent TEXT,
          reason TEXT,
          retained_records_summary JSONB DEFAULT '{}'::jsonb
      );
    `).catch((e) => console.warn('Migration ensure notice:', e.message));

    // Seed test database records
    const hashedPassword = await bcrypt.hash('SecurePassword123!', 10);

    const uid = Date.now().toString().slice(-6);

    // 1. Company with multiple users
    const compCode1 = `TEST-${uid}-1`;
    const compRes = await pool.query(
      `INSERT INTO companies (company_name, company_id, created_at)
       VALUES ('Acme Manufacturing Test', $1, NOW())
       RETURNING id`,
      [compCode1]
    );
    testCompanyId = compRes.rows[0].id;

    // Owner
    const ownerRes = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id, is_active, created_at)
       VALUES ('Alice Owner', $1, $2, 'owner', $3, TRUE, NOW())
       RETURNING id`,
      [`alice.owner.${uid}@example.com`, hashedPassword, testCompanyId]
    );
    testOwnerId = ownerRes.rows[0].id;
    await pool.query('UPDATE companies SET owner_id = $1 WHERE id = $2', [testOwnerId, testCompanyId]);

    // HR Lead (Admin capability)
    const adminRes = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id, is_active, created_at)
       VALUES ('Bob HR Lead', $1, $2, 'hr', $3, TRUE, NOW())
       RETURNING id`,
      [`bob.hr.${uid}@example.com`, hashedPassword, testCompanyId]
    );
    testAdminId = adminRes.rows[0].id;

    // Employee
    const empRes = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id, is_active, created_at)
       VALUES ('Charlie Engineer', $1, $2, 'employee', $3, TRUE, NOW())
       RETURNING id`,
      [`charlie.emp.${uid}@example.com`, hashedPassword, testCompanyId]
    );
    testEmployeeId = empRes.rows[0].id;

    // 2. Company with Sole Owner & active employee (to test owner deletion blockage)
    const compCode2 = `TEST-${uid}-2`;
    const soleCompRes = await pool.query(
      `INSERT INTO companies (company_name, company_id, created_at)
       VALUES ('Sole Owner Corp Test', $1, NOW())
       RETURNING id`,
      [compCode2]
    );
    testSoleOwnerCompId = soleCompRes.rows[0].id;

    const soleOwnerRes = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id, is_active, created_at)
       VALUES ('Dave SoleOwner', $1, $2, 'owner', $3, TRUE, NOW())
       RETURNING id`,
      [`dave.sole.${uid}@example.com`, hashedPassword, testSoleOwnerCompId]
    );
    testSoleOwnerId = soleOwnerRes.rows[0].id;
    await pool.query('UPDATE companies SET owner_id = $1 WHERE id = $2', [testSoleOwnerId, testSoleOwnerCompId]);

    // Add employee to Sole Owner's company so company is active
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id, is_active, created_at)
       VALUES ('Worker 1', $1, $2, 'employee', $3, TRUE, NOW())`,
      [`worker1.${uid}@example.com`, hashedPassword, testSoleOwnerCompId]
    );

    // 3. Customer portal account
    const custRes = await pool.query(
      `INSERT INTO customers (name, email, password_hash, company_id, is_verified, created_at)
       VALUES ('Frank Customer', $1, $2, $3, TRUE, NOW())
       RETURNING id`,
      [`frank.cust.${uid}@example.com`, hashedPassword, testCompanyId]
    );
    testCustomerId = custRes.rows[0].id;

    // Create Tokens
    tokenEmployee = createStaffToken({ userId: testEmployeeId, id: testEmployeeId, role: 'employee', companyId: testCompanyId, company_id: testCompanyId });
    tokenSoleOwner = createStaffToken({ userId: testSoleOwnerId, id: testSoleOwnerId, role: 'owner', companyId: testSoleOwnerCompId, company_id: testSoleOwnerCompId });
    tokenMultiOwner = createStaffToken({ userId: testOwnerId, id: testOwnerId, role: 'owner', companyId: testCompanyId, company_id: testCompanyId });
    tokenCustomer = createCustomerToken({ id: testCustomerId, userId: testCustomerId, role: 'customer', companyId: testCompanyId, company_id: testCompanyId });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // -------------------------------------------------------------------------
  // 1. Unauthenticated Checks
  // -------------------------------------------------------------------------
  test('Security: Unauthenticated deletion request is denied (401)', async () => {
    const res = await fetch(`${baseUrl}/api/account/deletion/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'AnyPassword' })
    });
    assert.equal(res.status, 401);
  });

  test('Security: Unauthenticated customer deletion request is denied (401)', async () => {
    const res = await fetch(`${baseUrl}/api/customer/profile/deletion/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'AnyPassword' })
    });
    assert.equal(res.status, 401);
  });

  // -------------------------------------------------------------------------
  // 2. Re-authentication Password Check
  // -------------------------------------------------------------------------
  test('Security: Deletion request with incorrect password is rejected (401)', async () => {
    const res = await fetch(`${baseUrl}/api/account/deletion/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEmployee}`
      },
      body: JSON.stringify({ password: 'WrongPassword999!' })
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
  });

  test('Security: Deletion request with missing password is rejected (400)', async () => {
    const res = await fetch(`${baseUrl}/api/account/deletion/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEmployee}`
      },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });

  // -------------------------------------------------------------------------
  // 3. Sole Owner Deletion Protection
  // -------------------------------------------------------------------------
  test('Owner Protection: Sole Owner cannot delete account if active company exists (403)', async () => {
    const res = await fetch(`${baseUrl}/api/account/deletion/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenSoleOwner}`
      },
      body: JSON.stringify({ password: 'SecurePassword123!' })
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.requiresOwnershipTransfer, true);
  });

  // -------------------------------------------------------------------------
  // 4. Employee Account Deletion Flow
  // -------------------------------------------------------------------------
  let employeeChallengeToken = '';

  test('Employee Deletion Step 1: Valid password generates 10-min challenge token', async () => {
    const res = await fetch(`${baseUrl}/api/account/deletion/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEmployee}`
      },
      body: JSON.stringify({ password: 'SecurePassword123!' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.challengeToken);
    assert.equal(body.confirmationPhrase, 'DELETE MY ACCOUNT');
    employeeChallengeToken = body.challengeToken;
  });

  test('Employee Deletion Step 2: Confirmation with wrong phrase is rejected (400)', async () => {
    const res = await fetch(`${baseUrl}/api/account/deletion/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEmployee}`
      },
      body: JSON.stringify({
        challenge_token: employeeChallengeToken,
        confirmation_phrase: 'delete'
      })
    });
    assert.equal(res.status, 400);
  });

  test('Employee Deletion Step 2: Confirmation with valid phrase successfully executes erasure', async () => {
    const res = await fetch(`${baseUrl}/api/account/deletion/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEmployee}`
      },
      body: JSON.stringify({
        challenge_token: employeeChallengeToken,
        confirmation_phrase: 'DELETE MY ACCOUNT',
        reason: 'Leaving company'
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    // Verify DB user record is anonymized and marked is_deleted
    const check = await pool.query('SELECT name, email, password_hash, is_deleted, is_active FROM users WHERE id::text = $1::text', [testEmployeeId]);
    assert.equal(check.rows[0].is_deleted, true);
    assert.equal(check.rows[0].is_active, false);
    assert.equal(check.rows[0].password_hash, null);
    assert.equal(check.rows[0].name, 'Former User [Deleted]');
    assert.ok(check.rows[0].email.includes('@anonymized.invalid'));
  });

  test('Security: Replay of consumed challenge token is denied (400)', async () => {
    const res = await fetch(`${baseUrl}/api/account/deletion/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEmployee}`
      },
      body: JSON.stringify({
        challenge_token: employeeChallengeToken,
        confirmation_phrase: 'DELETE MY ACCOUNT'
      })
    });
    assert.equal(res.status, 400);
  });

  // -------------------------------------------------------------------------
  // 5. Customer Portal Deletion Flow
  // -------------------------------------------------------------------------
  test('Customer Deletion: Full flow executes data erasure and anonymization', async () => {
    // Step 1: Request Challenge
    const reqRes = await fetch(`${baseUrl}/api/customer/profile/deletion/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenCustomer}`
      },
      body: JSON.stringify({ password: 'SecurePassword123!' })
    });
    assert.equal(reqRes.status, 200);
    const reqBody = await reqRes.json();
    assert.ok(reqBody.challengeToken);

    // Step 2: Confirm Deletion
    const confRes = await fetch(`${baseUrl}/api/customer/profile/deletion/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenCustomer}`
      },
      body: JSON.stringify({
        challenge_token: reqBody.challengeToken,
        confirmation_phrase: 'DELETE MY ACCOUNT'
      })
    });
    assert.equal(confRes.status, 200);

    // Verify DB customer record
    const custCheck = await pool.query('SELECT name, email, password_hash, is_deleted FROM customers WHERE id::text = $1::text', [testCustomerId]);
    assert.equal(custCheck.rows[0].is_deleted, true);
    assert.equal(custCheck.rows[0].password_hash, null);
    assert.equal(custCheck.rows[0].name, 'Deleted Customer');
    assert.ok(custCheck.rows[0].email.includes('@anonymized.invalid'));
  });

  // -------------------------------------------------------------------------
  // 6. Ownership Transfer Flow
  // -------------------------------------------------------------------------
  test('Owner Transfer: Owner transfers role to Admin then proceeds to deletion', async () => {
    // 1. Transfer ownership to Bob Admin
    const transferRes = await fetch(`${baseUrl}/api/account/transfer-ownership`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenMultiOwner}`
      },
      body: JSON.stringify({
        new_owner_id: testAdminId,
        password: 'SecurePassword123!'
      })
    });
    assert.equal(transferRes.status, 200);

    // 2. Former owner (now admin) can now request personal deletion
    const delReq = await fetch(`${baseUrl}/api/account/deletion/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenMultiOwner}`
      },
      body: JSON.stringify({ password: 'SecurePassword123!' })
    });
    assert.equal(delReq.status, 200);
    const delBody = await delReq.json();
    assert.ok(delBody.challengeToken);
  });
});
