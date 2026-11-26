'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hashToken } = require('../utils/tokenHash');

after(async () => {
  try { await require('../utils/redis').closeRedisConnections(); } catch (_) {}
  try { await require('../db').pool.end(); } catch (_) {}
});

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    cookies: {},
    clearedCookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    cookie(name, value, opts) {
      this.cookies[name] = { value, opts };
      return this;
    },
    clearCookie(name, opts) {
      this.clearedCookies.push({ name, opts });
      return this;
    },
  };
  return res;
}

describe('P0 Security Remediation — BL-01 Employee Onboarding Hijack Prevention', () => {
  test('Existing employee linked to Company A cannot attach to Company B (409 Conflict)', async () => {
    const db = require('../db');
    const companyIdGen = require('../utils/companyIdGenerator');
    const origConnect = db.pool.connect;
    const origValidate = companyIdGen.validateCompanyCode;

    const queries = [];
    companyIdGen.validateCompanyCode = async (code) => ({
      valid: true,
      company: { id: 202, company_id: code, company_name: 'Company B', status: 'active' },
    });
    db.pool.connect = async () => ({
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        if (String(sql).includes('FROM users') && String(sql).includes('FOR UPDATE')) {
          return {
            rows: [{
              id: '11111111-1111-4111-8111-111111111111',
              name: 'Alice',
              email: 'alice@companya.com',
              role: 'employee',
              company_id: 101,
              company_code: 'COMP-A',
            }],
          };
        }
        return { rows: [] };
      },
      release() {},
    });

    try {
      const authRouter = require('../routes/auth');
      const req = {
        user: { id: '11111111-1111-4111-8111-111111111111', role: 'employee', companyId: 101 },
        body: { name: 'Alice', company_code: 'COMP-B' },
        headers: {},
        ip: '127.0.0.1',
      };
      const res = createMockRes();
      await authRouter._completeEmployeeOnboardingHandler(req, res);

      assert.equal(res.statusCode, 409);
      assert.match(res.body.message, /already linked/i);
      assert.equal(queries.some((q) => q.sql.includes('UPDATE users')), false);
    } finally {
      db.pool.connect = origConnect;
      companyIdGen.validateCompanyCode = origValidate;
    }
  });

  test('Non-employee role (owner/admin/super_admin) is rejected with 403 Forbidden', async () => {
    const authRouter = require('../routes/auth');
    for (const role of ['owner', 'hr', 'admin', 'super_admin']) {
      const req = {
        user: { id: '11111111-1111-4111-8111-111111111111', role },
        body: { company_code: 'COMP-B' },
        headers: {},
      };
      const res = createMockRes();
      await authRouter._completeEmployeeOnboardingHandler(req, res);
      assert.equal(res.statusCode, 403);
    }
  });

  test('Seat limit cannot be bypassed during employee onboarding (403 Forbidden)', async () => {
    const db = require('../db');
    const companyIdGen = require('../utils/companyIdGenerator');
    const origConnect = db.pool.connect;
    const origValidate = companyIdGen.validateCompanyCode;

    companyIdGen.validateCompanyCode = async (code) => ({
      valid: true,
      company: { id: 202, company_id: code, company_name: 'Company B', status: 'active' },
    });
    db.pool.connect = async () => ({
      async query(sql) {
        const s = String(sql);
        if (s.includes('FROM companies c')) {
          // Starter plan (plan_id=1) has employeeLimit = 10
          return { rows: [{ plan_id: 1, current_count: 10 }] };
        }
        if (s.includes('FROM users') && s.includes('FOR UPDATE')) {
          return {
            rows: [{
              id: '22222222-2222-4222-8222-222222222222',
              name: 'Bob',
              email: 'bob@example.com',
              role: 'employee',
              company_id: null,
              company_code: null,
            }],
          };
        }
        return { rows: [] };
      },
      release() {},
    });

    try {
      const authRouter = require('../routes/auth');
      const req = {
        user: { id: '22222222-2222-4222-8222-222222222222', role: 'employee', companyId: null },
        body: { name: 'Bob', company_code: 'COMP-B' },
        headers: {},
        ip: '127.0.0.1',
      };
      const res = createMockRes();
      await authRouter._completeEmployeeOnboardingHandler(req, res);

      assert.equal(res.statusCode, 403);
      assert.match(res.body.message, /employee limit reached/i);
    } finally {
      db.pool.connect = origConnect;
      companyIdGen.validateCompanyCode = origValidate;
    }
  });

  test('Valid unlinked employee onboarding stores hashed refresh token (never plaintext)', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_access_secret_at_least_32_characters_long_12345';
    process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_at_least_32_characters_long_12345';

    const db = require('../db');
    const companyIdGen = require('../utils/companyIdGenerator');
    const origConnect = db.pool.connect;
    const origValidate = companyIdGen.validateCompanyCode;

    let insertedToken = null;
    companyIdGen.validateCompanyCode = async (code) => ({
      valid: true,
      company: { id: 101, company_id: code, company_name: 'Company A', status: 'active' },
    });
    db.pool.connect = async () => ({
      async query(sql, params) {
        const s = String(sql);
        if (s.includes('FROM companies c')) {
          return { rows: [{ plan_id: 1, current_count: 1 }] };
        }
        if (s.includes('FROM users') && s.includes('FOR UPDATE')) {
          return {
            rows: [{
              id: '33333333-3333-4333-8333-333333333333',
              name: 'Charlie',
              email: 'charlie@example.com',
              role: 'employee',
              company_id: null,
              company_code: null,
            }],
          };
        }
        if (s.includes('UPDATE users')) {
          return {
            rows: [{
              id: '33333333-3333-4333-8333-333333333333',
              name: 'Charlie',
              email: 'charlie@example.com',
              role: 'employee',
              company_id: 101,
              company_code: 'COMP-A',
            }],
          };
        }
        if (s.includes('INSERT INTO refresh_tokens')) {
          insertedToken = params[1];
          return { rows: [] };
        }
        return { rows: [] };
      },
      release() {},
    });

    try {
      const authRouter = require('../routes/auth');
      const req = {
        user: { id: '33333333-3333-4333-8333-333333333333', role: 'employee', companyId: null },
        body: { name: 'Charlie', company_code: 'COMP-A' },
        headers: { 'user-agent': 'node-test' },
        ip: '127.0.0.1',
      };
      const res = createMockRes();
      await authRouter._completeEmployeeOnboardingHandler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.ok(res.body.refreshToken);
      assert.ok(insertedToken);
      assert.notEqual(insertedToken, res.body.refreshToken);
      assert.equal(insertedToken, hashToken(res.body.refreshToken));
      assert.match(insertedToken, /^[0-9a-f]{64}$/);
    } finally {
      db.pool.connect = origConnect;
      companyIdGen.validateCompanyCode = origValidate;
    }
  });
});

describe('P0 Security Remediation — BL-02 Customer Logout Token Revocation', () => {
  test('Customer logout hashes refresh token, revokes token family, and clears cookies', async () => {
    const db = require('../db');
    const origQuery = db.pool.query;
    const rawRefreshToken = 'customer.jwt.refresh.token.value';
    const expectedHash = hashToken(rawRefreshToken);

    const tokenStore = new Map([
      [expectedHash, { id: 'tok-1', customer_id: 'cust-1', token_family: '44444444-4444-4444-8444-444444444444', revoked: false }],
    ]);
    const executedQueries = [];

    db.pool.query = async (sql, params = []) => {
      const s = String(sql);
      executedQueries.push({ sql: s, params });
      if (s.includes('SELECT id, customer_id, token_family FROM customer_refresh_tokens')) {
        const row = tokenStore.get(params[0]) || tokenStore.get(params[1]);
        return { rows: row ? [row] : [] };
      }
      if (s.includes('UPDATE customer_refresh_tokens SET revoked = TRUE')) {
        for (const row of tokenStore.values()) {
          if (row.customer_id === params[0] && row.token_family === params[1]) {
            row.revoked = true;
          }
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    };

    try {
      const customerAuthRouter = require('../routes/customer/auth');
      const req = {
        cookies: { customer_refresh_token: rawRefreshToken },
        body: {},
        ip: '127.0.0.1',
        get: () => 'node-test',
      };
      const res = createMockRes();
      await customerAuthRouter._customerLogoutHandler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(tokenStore.get(expectedHash).revoked, true);
      assert.equal(executedQueries[0].params[0], expectedHash);
      const clearedNames = res.clearedCookies.map((c) => c.name);
      assert.ok(clearedNames.includes('customer_access_token'));
      assert.ok(clearedNames.includes('customer_refresh_token'));
      assert.ok(clearedNames.includes('csrf_token'));
    } finally {
      db.pool.query = origQuery;
    }
  });
});

describe('P0 Security Remediation — Migration 054 Hardens 9 Core Tables Against GUC Bypass', () => {
  const CORE_NINE_TABLES = [
    'jobs',
    'attendance',
    'payroll',
    'messages',
    'employee_profiles',
    'employee_documents',
    'subscriptions',
    'subscription_events',
    'customers',
  ];

  test('Migration 054 replaces GUC-bypassable policies on all 9 core tables with role-based pg_has_role', () => {
    const sqlPath = path.join(__dirname, '../migrations/054_harden_core_and_remaining_rls_policies.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    for (const table of CORE_NINE_TABLES) {
      assert.ok(sql.includes(`'${table}'`), `Migration 054 must include ${table}`);
    }
    assert.ok(sql.includes("pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'')"));
    assert.ok(sql.includes('WITH CHECK'));
    assert.equal(/USING\s*\([^)]*bypass_rls/i.test(sql), false, 'Migration 054 must not reintroduce app.bypass_rls in policies');
    assert.equal(/USING\s*\([^)]*admin_bypass/i.test(sql), false, 'Migration 054 must not reintroduce admin_bypass in policies');
  });

  test('Migration 054 rollback SQL cleanly restores legacy 011 policies for emergency rollback', () => {
    const rollbackPath = path.join(__dirname, '../migrations/054_harden_core_and_remaining_rls_policies.rollback.sql');
    const sql = fs.readFileSync(rollbackPath, 'utf8');
    for (const table of CORE_NINE_TABLES) {
      assert.ok(sql.includes(`'${table}'`), `Rollback 054 must include ${table}`);
    }
  });
});
