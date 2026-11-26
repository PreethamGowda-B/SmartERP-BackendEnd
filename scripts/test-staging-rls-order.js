'use strict';

const { pool } = require('../db');
const { storage } = require('../middleware/als');

async function run() {
  try {
    console.log('=== TEST 1: Default Context (No ALS store / Fail-Closed) ===');
    const res1 = await pool.query(`
      SELECT
        current_user,
        current_setting('app.bypass_rls', true) AS bypass_rls,
        current_setting('app.current_company_id', true) AS company_id,
        current_setting('app.current_role', true) AS role,
        current_setting('app.current_user_id', true) AS user_id
    `);
    console.log('Test 1 Result:', res1.rows[0]);

    console.log('\n=== TEST 2: Active Tenant Context (Company 42, Employee) ===');
    await storage.run({
      companyId: '42',
      userId: '11111111-2222-3333-4444-555555555555',
      role: 'employee',
      bypassRls: false
    }, async () => {
      const res2 = await pool.query(`
        SELECT
          current_user,
          current_setting('app.bypass_rls', true) AS bypass_rls,
          current_setting('app.current_company_id', true) AS company_id,
          current_setting('app.current_role', true) AS role,
          current_setting('app.current_user_id', true) AS user_id
      `);
      console.log('Test 2 Result:', res2.rows[0]);
    });

    console.log('\n=== TEST 3: Bypass RLS Context ===');
    await storage.run({
      bypassRls: true
    }, async () => {
      const res3 = await pool.query(`
        SELECT
          current_user,
          current_setting('app.bypass_rls', true) AS bypass_rls,
          current_setting('app.current_company_id', true) AS company_id
      `);
      console.log('Test 3 Result:', res3.rows[0]);
    });

    console.log('\n=== TEST 4: Query Order & Transaction Semantics Verification ===');
    // Test that an explicit multi-query transaction retains RLS context across queries
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r1 = await client.query("SELECT current_user, current_setting('app.current_company_id', true) AS cid");
      console.log('Transaction Query 1:', r1.rows[0]);
      const r2 = await client.query("SELECT current_user, current_setting('app.current_company_id', true) AS cid");
      console.log('Transaction Query 2:', r2.rows[0]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    console.log('\nAll staging RLS tests completed successfully!');
  } catch (err) {
    console.error('Test failed with error:', err);
  } finally {
    await pool.end();
  }
}

run();
