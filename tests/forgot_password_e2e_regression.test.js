/**
 * Comprehensive End-to-End Test Suite for Forgot Password / Password Recovery System
 * Covers:
 * - Owner flow
 * - Employee flow
 * - HR flow
 * - Customer flow
 * - Expired OTP rejection
 * - Brute force attempts rejection
 * - Single-use token enforcement
 * - Cross-portal isolation
 * - Old password invalidation & new password login
 * - Refresh token session family revocation
 * - Anti-enumeration behavior
 */

const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { redisClient } = require('../utils/redis');

// Setup test app mounting the exact backend routes
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', require('../routes/auth'));
app.use('/api/customer/auth', require('../routes/customer/auth'));

let server;
let baseUrl;

function computeHmac(data) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'smarterp_default_sec_salt').update(String(data)).digest('hex');
}

async function makeRequest(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  const setCookie = res.headers.get('set-cookie');

  return {
    status: res.status,
    ok: res.ok,
    data,
    setCookie,
  };
}

async function runTests() {
  console.log('🚀 Starting Forgot Password & Password Recovery E2E Regression Suite...\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // Create temporary test users for all 4 roles
  const testCompanyCode = 'TEST_CORP_' + Date.now();
  let companyId;
  let ownerEmail = `test_owner_${Date.now()}@example.com`;
  let employeeEmail = `test_employee_${Date.now()}@example.com`;
  let hrEmail = `test_hr_${Date.now()}@example.com`;
  let customerEmail = `test_customer_${Date.now()}@example.com`;

  const initialPassword = 'InitialPassword@123';
  const newPassword = 'NewSecretPassword@456';
  const initialHash = await bcrypt.hash(initialPassword, 10);

  try {
    // 1. Get or create company
    const compCheck = await pool.query(`SELECT id FROM companies LIMIT 1`);
    if (compCheck.rows.length > 0) {
      companyId = compCheck.rows[0].id;
    } else {
      const compRes = await pool.query(
        `INSERT INTO companies (company_name, company_id) 
         VALUES ('Recovery Test Corp', $1) RETURNING id`,
        [testCompanyCode]
      );
      companyId = compRes.rows[0].id;
    }

    // 2. Create Owner, Employee, HR in `users`
    const ownerRes = await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active, password_set) 
       VALUES ($1, 'Test Owner', $2, $3, 'owner', true, true) RETURNING id`,
      [companyId, ownerEmail, initialHash]
    );
    const ownerId = ownerRes.rows[0].id;

    const empRes = await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active, password_set) 
       VALUES ($1, 'Test Employee', $2, $3, 'employee', true, true) RETURNING id`,
      [companyId, employeeEmail, initialHash]
    );
    const empId = empRes.rows[0].id;

    const hrRes = await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active, password_set) 
       VALUES ($1, 'Test HR', $2, $3, 'hr', true, true) RETURNING id`,
      [companyId, hrEmail, initialHash]
    );
    const hrId = hrRes.rows[0].id;

    // 3. Create Customer in `customers`
    const custRes = await pool.query(
      `INSERT INTO customers (company_id, name, email, password_hash, is_verified) 
       VALUES ($1, 'Test Customer', $2, $3, true) RETURNING id`,
      [companyId, customerEmail, initialHash]
    );
    const custId = custRes.rows[0].id;

    // Add mock refresh token for owner to test revocation
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, token_family, expires_at) 
       VALUES ($1, 'mock_token_123', gen_random_uuid(), NOW() + INTERVAL '30 days')`,
      [ownerId]
    );

    // --- TEST 1: Anti-Enumeration for Unknown Email ---
    console.log('\n--- 1. Testing Anti-Enumeration ---');
    const randomUnknownEmail = `nonexistent_account_${Date.now()}@example.com`;
    const unknownRes = await makeRequest('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: randomUnknownEmail },
    });
    assert(unknownRes.status === 200, 'Unknown email returns 200 OK');
    assert(
      unknownRes.data?.message === "If an account exists for this email, we've sent verification instructions.",
      'Anti-enumeration message returned verbatim'
    );

    // --- TEST 2: Owner Recovery Flow ---
    console.log('\n--- 2. Testing Owner Recovery Flow ---');
    const ownerForgot = await makeRequest('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: ownerEmail },
    });
    assert(ownerForgot.status === 200, 'Owner forgot password returns 200 OK');

    // Retrieve generated OTP from DB
    const ownerOtpRow = await pool.query(
      `SELECT * FROM email_otps WHERE LOWER(email) = $1 AND account_type = 'staff' AND used = FALSE ORDER BY created_at DESC LIMIT 1`,
      [ownerEmail.toLowerCase()]
    );
    assert(ownerOtpRow.rows.length === 1, 'Owner OTP hash stored in DB with account_type = staff');

    // Test verifying with known OTP by finding the match (or set known OTP)
    const testOtp = '654321';
    const testOtpHash = computeHmac(testOtp + ownerEmail.toLowerCase());
    await pool.query(
      `UPDATE email_otps SET otp_code = $1 WHERE id = $2`,
      [testOtpHash, ownerOtpRow.rows[0].id]
    );

    const ownerVerify = await makeRequest('/api/auth/verify-reset-otp', {
      method: 'POST',
      body: { email: ownerEmail, otp: testOtp },
    });
    assert(ownerVerify.status === 200, 'Owner OTP verified successfully');
    assert(!!ownerVerify.data.reset_token, 'Single-use reset authorization token received');

    const ownerResetToken = ownerVerify.data.reset_token;

    // Reset password
    const ownerReset = await makeRequest('/api/auth/reset-password', {
      method: 'POST',
      body: {
        email: ownerEmail,
        reset_token: ownerResetToken,
        new_password: newPassword,
      },
    });
    assert(ownerReset.status === 200, 'Owner password reset succeeded');

    // Verify session revocation
    const remainingTokens = await pool.query(
      `SELECT * FROM refresh_tokens WHERE user_id = $1`,
      [ownerId]
    );
    assert(remainingTokens.rows.length === 0, 'Active refresh tokens revoked upon password reset');

    // Clear any IP-based login rate limit that may have accumulated from rapid test reruns
    if (redisClient && redisClient.status === 'ready') {
      await redisClient.del('login_ip_limit:::1').catch(() => {});
      await redisClient.del('login_ip_limit:::ffff:127.0.0.1').catch(() => {});
      await redisClient.del('login_ip_limit:127.0.0.1').catch(() => {});
      await redisClient.del(`login_acc_limit:${ownerEmail}`).catch(() => {});
    }

    // Verify old password fails & new password succeeds
    const ownerOldLogin = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: ownerEmail, password: initialPassword, role: 'owner' },
    });
    assert(ownerOldLogin.status === 401, 'Owner old password is now rejected (401)');

    const ownerNewLogin = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: ownerEmail, password: newPassword, role: 'owner' },
    });
    assert(ownerNewLogin.status === 200, 'Owner signs in successfully with new password');

    // --- TEST 3: Employee Recovery Flow ---
    console.log('\n--- 3. Testing Employee Recovery Flow ---');
    await makeRequest('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: employeeEmail },
    });
    const empOtpRow = await pool.query(
      `SELECT * FROM email_otps WHERE LOWER(email) = $1 AND account_type = 'staff' AND used = FALSE ORDER BY created_at DESC LIMIT 1`,
      [employeeEmail.toLowerCase()]
    );
    const empTestOtp = '112233';
    await pool.query(
      `UPDATE email_otps SET otp_code = $1 WHERE id = $2`,
      [computeHmac(empTestOtp + employeeEmail.toLowerCase()), empOtpRow.rows[0].id]
    );

    const empVerify = await makeRequest('/api/auth/verify-reset-otp', {
      method: 'POST',
      body: { email: employeeEmail, otp: empTestOtp },
    });
    assert(empVerify.status === 200, 'Employee OTP verified successfully');

    const empReset = await makeRequest('/api/auth/reset-password', {
      method: 'POST',
      body: {
        email: employeeEmail,
        reset_token: empVerify.data.reset_token,
        new_password: newPassword,
      },
    });
    assert(empReset.status === 200, 'Employee password reset succeeded');

    if (redisClient && redisClient.status === 'ready') {
      await redisClient.del('login_ip_limit:::1').catch(() => {});
      await redisClient.del('login_ip_limit:::ffff:127.0.0.1').catch(() => {});
      await redisClient.del('login_ip_limit:127.0.0.1').catch(() => {});
      await redisClient.del(`login_acc_limit:${employeeEmail}`).catch(() => {});
    }
    const empLogin = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: employeeEmail, password: newPassword, role: 'employee' },
    });
    assert(empLogin.status === 200, 'Employee signs in with new password');

    // --- TEST 4: HR Recovery Flow ---
    console.log('\n--- 4. Testing HR Recovery Flow ---');
    await makeRequest('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: hrEmail },
    });
    const hrOtpRow = await pool.query(
      `SELECT * FROM email_otps WHERE LOWER(email) = $1 AND account_type = 'staff' AND used = FALSE ORDER BY created_at DESC LIMIT 1`,
      [hrEmail.toLowerCase()]
    );
    const hrTestOtp = '445566';
    await pool.query(
      `UPDATE email_otps SET otp_code = $1 WHERE id = $2`,
      [computeHmac(hrTestOtp + hrEmail.toLowerCase()), hrOtpRow.rows[0].id]
    );

    const hrVerify = await makeRequest('/api/auth/verify-reset-otp', {
      method: 'POST',
      body: { email: hrEmail, otp: hrTestOtp },
    });
    assert(hrVerify.status === 200, 'HR OTP verified successfully');

    const hrReset = await makeRequest('/api/auth/reset-password', {
      method: 'POST',
      body: {
        email: hrEmail,
        reset_token: hrVerify.data.reset_token,
        new_password: newPassword,
      },
    });
    assert(hrReset.status === 200, 'HR password reset succeeded');

    if (redisClient && redisClient.status === 'ready') {
      await redisClient.del('login_ip_limit:::1').catch(() => {});
      await redisClient.del('login_ip_limit:::ffff:127.0.0.1').catch(() => {});
      await redisClient.del('login_ip_limit:127.0.0.1').catch(() => {});
      await redisClient.del(`login_acc_limit:${hrEmail}`).catch(() => {});
    }
    const hrLogin = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: hrEmail, password: newPassword, role: 'employee' },
    });
    assert(hrLogin.status === 200, 'HR signs in with new password');

    // --- TEST 5: Customer Recovery Flow ---
    console.log('\n--- 5. Testing Customer Recovery Flow ---');
    const custForgot = await makeRequest('/api/customer/auth/forgot-password', {
      method: 'POST',
      body: { email: customerEmail },
    });
    assert(custForgot.status === 200, 'Customer forgot password returns 200 OK');

    const custOtpRow = await pool.query(
      `SELECT * FROM email_otps WHERE LOWER(email) = $1 AND account_type = 'customer' AND used = FALSE ORDER BY created_at DESC LIMIT 1`,
      [customerEmail.toLowerCase()]
    );
    assert(custOtpRow.rows.length === 1, 'Customer OTP hash stored in DB with account_type = customer');

    const custTestOtp = '778899';
    await pool.query(
      `UPDATE email_otps SET otp_code = $1 WHERE id = $2`,
      [computeHmac(custTestOtp + customerEmail.toLowerCase()), custOtpRow.rows[0].id]
    );

    const custVerify = await makeRequest('/api/customer/auth/verify-reset-otp', {
      method: 'POST',
      body: { email: customerEmail, otp: custTestOtp },
    });
    assert(custVerify.status === 200, 'Customer OTP verified successfully');

    const custReset = await makeRequest('/api/customer/auth/reset-password', {
      method: 'POST',
      body: {
        email: customerEmail,
        reset_token: custVerify.data.reset_token,
        new_password: newPassword,
      },
    });
    assert(custReset.status === 200, 'Customer password reset succeeded');

    const custLogin = await makeRequest('/api/customer/auth/login', {
      method: 'POST',
      body: { email: customerEmail, password: newPassword },
    });
    assert(custLogin.status === 200, 'Customer signs in with new password');

    // --- TEST 6: Expired OTP Rejection ---
    console.log('\n--- 6. Testing Expired OTP Rejection ---');
    await pool.query(
      `INSERT INTO email_otps (email, otp_code, account_type, expires_at) 
       VALUES ($1, $2, 'staff', NOW() - INTERVAL '1 minute')`,
      [ownerEmail.toLowerCase(), computeHmac('999999' + ownerEmail.toLowerCase())]
    );
    const expiredVerify = await makeRequest('/api/auth/verify-reset-otp', {
      method: 'POST',
      body: { email: ownerEmail, otp: '999999' },
    });
    assert(expiredVerify.status === 400, 'Expired OTP is rejected with 400 Bad Request');

    // --- TEST 7: OTP Brute-force Attempts Enforcement ---
    console.log('\n--- 7. Testing OTP Max Verification Attempts ---');
    const bruteEmail = `brute_test_${Date.now()}@example.com`;
    const bruteUser = await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active, password_set) 
       VALUES ($1, 'Brute Test', $2, $3, 'employee', true, true) RETURNING id`,
      [companyId, bruteEmail, initialHash]
    );

    const bruteOtp = '123456';
    await pool.query(
      `INSERT INTO email_otps (email, otp_code, account_type, expires_at, attempts) 
       VALUES ($1, $2, 'staff', NOW() + INTERVAL '10 minutes', 0)`,
      [bruteEmail.toLowerCase(), computeHmac(bruteOtp + bruteEmail.toLowerCase())]
    );

    // Make 5 wrong attempts
    for (let i = 0; i < 5; i++) {
      await makeRequest('/api/auth/verify-reset-otp', {
        method: 'POST',
        body: { email: bruteEmail, otp: '000000' },
      });
    }

    // Now attempt with the correct OTP — it must be invalidated / rate limited
    const postBruteAttempt = await makeRequest('/api/auth/verify-reset-otp', {
      method: 'POST',
      body: { email: bruteEmail, otp: bruteOtp },
    });
    assert(postBruteAttempt.status === 400 || postBruteAttempt.status === 429, 'OTP invalidated after 5 failed attempts (brute force prevented)');

    // --- TEST 8: Single-Use Reset Token Enforcement ---
    console.log('\n--- 8. Testing Single-Use Reset Token Enforcement ---');
    const reusedAttempt = await makeRequest('/api/auth/reset-password', {
      method: 'POST',
      body: {
        email: ownerEmail,
        reset_token: ownerResetToken, // Already used in Test 2
        new_password: 'AnotherPassword@789',
      },
    });
    assert(reusedAttempt.status === 400, 'Re-using a consumed reset authorization token is rejected');

    // --- TEST 9: Cross-Portal Account Segregation ---
    console.log('\n--- 9. Testing Cross-Portal Isolation ---');
    // Try to verify staff email using Customer Portal endpoint
    const crossPortalAttempt = await makeRequest('/api/customer/auth/forgot-password', {
      method: 'POST',
      body: { email: ownerEmail }, // staff email
    });
    assert(crossPortalAttempt.status === 200, 'Customer forgot password returns generic 200');

    const crossOtpCheck = await pool.query(
      `SELECT * FROM email_otps WHERE LOWER(email) = $1 AND account_type = 'customer'`,
      [ownerEmail.toLowerCase()]
    );
    assert(crossOtpCheck.rows.length === 0, 'No customer OTP issued for staff email (Cross-portal isolation verified)');

    // Clean up test data
    await pool.query("DELETE FROM refresh_tokens WHERE user_id IN ($1, $2, $3, $4)", [ownerId, empId, hrId, bruteUser.rows[0].id]);
    await pool.query("DELETE FROM password_reset_tokens WHERE email IN ($1, $2, $3, $4, $5)", [ownerEmail, employeeEmail, hrEmail, customerEmail, bruteEmail]);
    await pool.query("DELETE FROM email_otps WHERE email IN ($1, $2, $3, $4, $5)", [ownerEmail, employeeEmail, hrEmail, customerEmail, bruteEmail]);
    await pool.query("DELETE FROM users WHERE id IN ($1, $2, $3, $4)", [ownerId, empId, hrId, bruteUser.rows[0].id]);
    await pool.query("DELETE FROM customers WHERE id = $1", [custId]);

  } catch (err) {
    console.error('💥 Test suite runtime exception:', err);
    failed++;
  }

  console.log('\n========================================');
  console.log(`🏁 Test Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Start test server on dynamic port
server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`🧪 Test server running on ${baseUrl}`);
  runTests().finally(() => {
    server.close();
    pool.end();
  });
});
