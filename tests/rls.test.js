/**
 * SmartERP — RLS Integration Tests
 *
 * Verifies that PostgreSQL Row-Level Security is enforced correctly.
 * These tests hit a REAL database connection, so they require:
 *   1. DATABASE_URL env variable pointing to a test/staging database.
 *   2. The rls_policies.sql migration to have been applied to that database.
 *
 * Run:
 *   node --test tests/rls.test.js
 *
 * Schema facts (confirmed by inspect_schema_temp.js):
 *   companies: id INTEGER, company_name VARCHAR, company_id VARCHAR (public code)
 *   jobs:      id UUID,    company_id INTEGER
 *
 * Framework: Node.js built-in test runner (Node 18+)
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ─── Setup ─────────────────────────────────────────────────────────────────────
// Import the ALS storage BEFORE requiring db.js so the patched pool.connect()
// picks up contexts we set in tests.
const { storage } = require('../middleware/als');

// Load the patched pool (pool.connect + pool.query both set RLS session vars)
const { pool } = require('../db');
const { runNumberedMigrations } = require('../migrations/autoMigrate');

// ─── Test Data ────────────────────────────────────────────────────────────────
let companyAId, companyBId;  // integer PKs from the companies table
let jobAId, jobBId;          // uuid PKs from the jobs table

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a query inside a specific ALS context.
 */
async function runWithContext(context, sql, params = []) {
  return new Promise((resolve, reject) => {
    storage.run(context, async () => {
      try {
        resolve(await pool.query(sql, params));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Run a query with NO ALS context at all.
 * Simulates a background query that forgot to call storage.run() — the exact
 * bug RLS is meant to catch.
 */
async function runWithNoContext(sql, params = []) {
  // Deliberately NOT calling storage.run(). getStore() returns undefined.
  return pool.query(sql, params);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

before(async () => {
  await new Promise((resolve, reject) => {
    storage.run({ bypassRls: true }, async () => {
      try {
        // Run numbered migrations first to ensure the test database schema is up-to-date (creates conversations, messages columns, etc.)
        console.log('Running numbered migrations...');
        await runNumberedMigrations();

        // Apply rls_policies.sql migration to the DB for the test duration
        const sqlPath = path.join(__dirname, '../migrations/rls_policies.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        console.log('Applying RLS policies DDL...');
        await pool.query(sql);

        // Insert two isolated test companies
        const companyInsert = `
          INSERT INTO companies (company_name, company_id, status)
          VALUES
            ('RLS Test Company A', 'rls-test-a-' || floor(random()*1000000)::text, 'active'),
            ('RLS Test Company B', 'rls-test-b-' || floor(random()*1000000)::text, 'active')
          RETURNING id
        `;
        const cResult = await pool.query(companyInsert);
        companyAId = cResult.rows[0].id;  // INTEGER
        companyBId = cResult.rows[1].id;

        // Insert one job row per company
        const jobInsert = `
          INSERT INTO jobs (title, company_id, status)
          VALUES
            ('RLS Test Job A', $1, 'pending'),
            ('RLS Test Job B', $2, 'pending')
          RETURNING id
        `;
        const jResult = await pool.query(jobInsert, [companyAId, companyBId]);
        jobAId = jResult.rows[0].id;  // UUID
        jobBId = jResult.rows[1].id;

        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => {
    storage.run({ bypassRls: true }, async () => {
      try {
        // Clean up test data
        await pool.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [[jobAId, jobBId]]);
        await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [[companyAId, companyBId]]);

        // Disable RLS and drop policies to restore database clean state
        console.log('Cleaning up RLS policies DDL...');
        const disableSql = `
          ALTER TABLE inventory_items    DISABLE ROW LEVEL SECURITY;
          ALTER TABLE payroll             DISABLE ROW LEVEL SECURITY;
          ALTER TABLE jobs                DISABLE ROW LEVEL SECURITY;
          ALTER TABLE attendance          DISABLE ROW LEVEL SECURITY;
          ALTER TABLE notifications       DISABLE ROW LEVEL SECURITY;
          ALTER TABLE material_requests   DISABLE ROW LEVEL SECURITY;
          ALTER TABLE messages            DISABLE ROW LEVEL SECURITY;
          ALTER TABLE job_messages        DISABLE ROW LEVEL SECURITY;
          ALTER TABLE employee_documents  DISABLE ROW LEVEL SECURITY;
          ALTER TABLE customers           DISABLE ROW LEVEL SECURITY;
          ALTER TABLE conversations       DISABLE ROW LEVEL SECURITY;
          ALTER TABLE employee_profiles   DISABLE ROW LEVEL SECURITY;
          ALTER TABLE activities          DISABLE ROW LEVEL SECURITY;
          ALTER TABLE company_settings    DISABLE ROW LEVEL SECURITY;
          ALTER TABLE sla_configs         DISABLE ROW LEVEL SECURITY;
          ALTER TABLE invoices            DISABLE ROW LEVEL SECURITY;
          ALTER TABLE job_materials       DISABLE ROW LEVEL SECURITY;
          ALTER TABLE branches            DISABLE ROW LEVEL SECURITY;
          
          DROP POLICY IF EXISTS inventory_company_isolation       ON inventory_items;
          DROP POLICY IF EXISTS payroll_company_isolation          ON payroll;
          DROP POLICY IF EXISTS jobs_company_isolation             ON jobs;
          DROP POLICY IF EXISTS attendance_company_isolation       ON attendance;
          DROP POLICY IF EXISTS notifications_company_isolation    ON notifications;
          DROP POLICY IF EXISTS material_requests_company_isolation ON material_requests;
          DROP POLICY IF EXISTS messages_company_isolation         ON messages;
          DROP POLICY IF EXISTS job_messages_company_isolation     ON job_messages;
          DROP POLICY IF EXISTS employee_documents_company_isolation ON employee_documents;
          DROP POLICY IF EXISTS customers_company_isolation        ON customers;
          DROP POLICY IF EXISTS conversations_company_isolation    ON conversations;
          DROP POLICY IF EXISTS employee_profiles_company_isolation ON employee_profiles;
          DROP POLICY IF EXISTS activities_company_isolation       ON activities;
          DROP POLICY IF EXISTS company_settings_company_isolation ON company_settings;
          DROP POLICY IF EXISTS sla_configs_company_isolation      ON sla_configs;
          DROP POLICY IF EXISTS invoices_company_isolation         ON invoices;
          DROP POLICY IF EXISTS job_materials_company_isolation    ON job_materials;
          DROP POLICY IF EXISTS branches_company_isolation         ON branches;
        `;
        await pool.query(disableSql);

        await pool.end();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RLS: Fail-Closed Isolation', () => {

  test('NO CONTEXT → returns 0 rows (fail-closed)', async () => {
    // THE critical test. Any query that escapes ALS context must return nothing,
    // not everything. This catches bugs where storage.run() was never called.
    const result = await runWithNoContext(
      `SELECT id FROM jobs WHERE id = ANY($1::uuid[])`,
      [[jobAId, jobBId]]
    );
    assert.equal(
      result.rows.length,
      0,
      `FAIL-CLOSED VIOLATION: Got ${result.rows.length} rows with no ALS context — expected 0. ` +
      'RLS policies are NOT enforced. Check that FORCE ROW LEVEL SECURITY is applied to the jobs table.'
    );
  });

  test('Company A context → sees only Company A jobs', async () => {
    const result = await runWithContext(
      { isWebRequest: true, companyId: String(companyAId), bypassRls: false },
      `SELECT id, company_id FROM jobs WHERE id = ANY($1::uuid[])`,
      [[jobAId, jobBId]]
    );
    const ids = result.rows.map(r => String(r.id));
    assert.ok(ids.includes(String(jobAId)), 'Company A should see its own job');
    assert.ok(!ids.includes(String(jobBId)), 'Company A must NOT see Company B job');
  });

  test('Company B context → sees only Company B jobs', async () => {
    const result = await runWithContext(
      { isWebRequest: true, companyId: String(companyBId), bypassRls: false },
      `SELECT id, company_id FROM jobs WHERE id = ANY($1::uuid[])`,
      [[jobAId, jobBId]]
    );
    const ids = result.rows.map(r => String(r.id));
    assert.ok(ids.includes(String(jobBId)), 'Company B should see its own job');
    assert.ok(!ids.includes(String(jobAId)), 'Company B must NOT see Company A job');
  });

  test('bypassRls: true → sees ALL rows (explicit cross-tenant bypass)', async () => {
    const result = await runWithContext(
      { isWebRequest: true, bypassRls: true },
      `SELECT id FROM jobs WHERE id = ANY($1::uuid[])`,
      [[jobAId, jobBId]]
    );
    const ids = result.rows.map(r => String(r.id));
    assert.ok(ids.includes(String(jobAId)), 'Bypass context must see Company A job');
    assert.ok(ids.includes(String(jobBId)), 'Bypass context must see Company B job');
  });

  test('super_admin role → sees ALL rows', async () => {
    const result = await runWithContext(
      { isWebRequest: true, role: 'super_admin', bypassRls: false },
      `SELECT id FROM jobs WHERE id = ANY($1::uuid[])`,
      [[jobAId, jobBId]]
    );
    const ids = result.rows.map(r => String(r.id));
    assert.ok(ids.includes(String(jobAId)), 'super_admin must see Company A job');
    assert.ok(ids.includes(String(jobBId)), 'super_admin must see Company B job');
  });

  test('isWebRequest: true with no companyId → returns 0 rows (fail-closed)', async () => {
    // Simulates a route that called next() without setTenantContext being invoked.
    const result = await runWithContext(
      { isWebRequest: true, bypassRls: false },
      `SELECT id FROM jobs WHERE id = ANY($1::uuid[])`,
      [[jobAId, jobBId]]
    );
    assert.equal(
      result.rows.length,
      0,
      `Expected 0 rows when companyId is missing but bypassRls=false, got ${result.rows.length}`
    );
  });

});
