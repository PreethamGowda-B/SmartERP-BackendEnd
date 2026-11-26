'use strict';
require('dotenv').config();
const assert = require('assert/strict');
const { pool, withTransaction } = require('./db');
const { storage } = require('./middleware/als');

async function runSecurityVerification() {
  console.log('===============================================================');
  console.log('🔒 TASK 5: SECURITY & MULTI-TENANT ISOLATION VERIFICATION');
  console.log('===============================================================');

  // Test 1: Cross-company job isolation
  console.log('\n[1/7] Testing cross-company job isolation (Company 1 vs Company 6)...');
  const comp1Jobs = await storage.run({ companyId: 1, userId: '00000000-0000-0000-0000-000000000001', role: 'owner' }, async () => {
    const res = await pool.query('SELECT id, company_id, title FROM jobs LIMIT 10;');
    return res.rows;
  });
  console.log(`  Company 1 can see ${comp1Jobs.length} jobs.`);
  for (const job of comp1Jobs) {
    assert.equal(String(job.company_id), '1', `Security breach: Company 1 saw job from company ${job.company_id}`);
  }

  if (comp1Jobs.length > 0) {
    const targetJobId = comp1Jobs[0].id;
    const comp6Probe = await storage.run({ companyId: 6, userId: '00000000-0000-0000-0000-000000000002', role: 'owner' }, async () => {
      const res = await pool.query('SELECT id, company_id, title FROM jobs WHERE id = $1;', [targetJobId]);
      return res.rows;
    });
    assert.equal(comp6Probe.length, 0, `Security breach: Company 6 was able to read Company 1 job ${targetJobId}`);
    console.log(`  ✅ Company 6 probed Company 1 job ID (${targetJobId}): returned 0 rows (BLOCKED).`);
  }

  // Test 2: Cross-company inventory isolation
  console.log('\n[2/7] Testing cross-company inventory isolation...');
  const comp1Inventory = await storage.run({ companyId: 1, userId: '00000000-0000-0000-0000-000000000001', role: 'owner' }, async () => {
    const res = await pool.query('SELECT id, company_id, name FROM inventory_items LIMIT 10;');
    return res.rows;
  });
  console.log(`  Company 1 can see ${comp1Inventory.length} inventory items.`);
  for (const item of comp1Inventory) {
    assert.equal(String(item.company_id), '1', `Security breach: Company 1 saw inventory from company ${item.company_id}`);
  }

  if (comp1Inventory.length > 0) {
    const targetItemId = comp1Inventory[0].id;
    const comp6Probe = await storage.run({ companyId: 6, userId: '00000000-0000-0000-0000-000000000002', role: 'owner' }, async () => {
      const res = await pool.query('SELECT id, company_id, name FROM inventory_items WHERE id = $1;', [targetItemId]);
      return res.rows;
    });
    assert.equal(comp6Probe.length, 0, `Security breach: Company 6 was able to read Company 1 inventory item ${targetItemId}`);
    console.log(`  ✅ Company 6 probed Company 1 inventory item ID (${targetItemId}): returned 0 rows (BLOCKED).`);
  }

  // Test 3: Cross-company notifications isolation
  console.log('\n[3/7] Testing cross-company notifications isolation...');
  const comp1Notifs = await storage.run({ companyId: 1, userId: '00000000-0000-0000-0000-000000000001', role: 'owner' }, async () => {
    const res = await pool.query('SELECT id, company_id FROM notifications LIMIT 10;');
    return res.rows;
  });
  console.log(`  Company 1 checked notifications: ${comp1Notifs.length} rows.`);
  for (const notif of comp1Notifs) {
    assert.equal(String(notif.company_id), '1', `Security breach: Company 1 saw notification from company ${notif.company_id}`);
  }
  console.log('  ✅ Notifications isolation confirmed.');

  // Test 4: Role permissions and tenant context application
  console.log('\n[4/7] Testing role permissions and tenant context application...');
  await storage.run({ companyId: 1, userId: '00000000-0000-0000-0000-000000000001', role: 'owner' }, async () => {
    const res = await pool.query(`
      SELECT 
        current_setting('app.current_user_id', true) as user_id,
        current_setting('app.current_company_id', true) as company_id,
        current_setting('app.current_role', true) as role,
        current_user as db_user;
    `);
    const r = res.rows[0];
    assert.equal(r.company_id, '1');
    assert.equal(r.role, 'owner');
    assert.equal(r.db_user, 'smarterp_app');
    console.log(`  ✅ Owner context verified: db_user=${r.db_user}, role=${r.role}, company_id=${r.company_id}`);
  });

  await storage.run({ companyId: 1, userId: '00000000-0000-0000-0000-000000000003', role: 'employee' }, async () => {
    const res = await pool.query(`
      SELECT 
        current_setting('app.current_user_id', true) as user_id,
        current_setting('app.current_company_id', true) as company_id,
        current_setting('app.current_role', true) as role,
        current_user as db_user;
    `);
    const r = res.rows[0];
    assert.equal(r.company_id, '1');
    assert.equal(r.role, 'employee');
    assert.equal(r.db_user, 'smarterp_app');
    console.log(`  ✅ Employee context verified: db_user=${r.db_user}, role=${r.role}, company_id=${r.company_id}`);
  });

  // Test 5: Connection reuse between different tenants on the same physical connection
  console.log('\n[5/7] Testing connection reuse across tenants on a single checked-out connection...');
  const client = await pool.connect();
  try {
    // Tenant A
    await storage.run({ companyId: 1, userId: '00000000-0000-0000-0000-000000000001', role: 'owner' }, async () => {
      const res = await client.query(`
        SELECT current_setting('app.current_company_id', true) as comp, current_user as usr;
      `);
      assert.equal(res.rows[0].comp, '1');
      assert.equal(res.rows[0].usr, 'smarterp_app');
    });

    // Tenant B on same client
    await storage.run({ companyId: 6, userId: '00000000-0000-0000-0000-000000000002', role: 'owner' }, async () => {
      const res = await client.query(`
        SELECT current_setting('app.current_company_id', true) as comp, current_user as usr;
      `);
      assert.equal(res.rows[0].comp, '6');
      assert.equal(res.rows[0].usr, 'smarterp_app');
    });
    console.log('  ✅ Single connection switched cleanly from Company 1 to Company 6 with zero state leakage.');
  } finally {
    client.release();
  }

  // Test 6: RLS context reset outside of tenant ALS context
  console.log('\n[6/7] Testing RLS context reset outside of tenant ALS context...');
  const bareRes = await pool.query(`
    SELECT 
      current_setting('app.current_company_id', true) as comp,
      current_setting('app.current_role', true) as role,
      current_user as usr;
  `);
  const bare = bareRes.rows[0];
  assert.equal(bare.comp, '');
  assert.equal(bare.role, '');
  assert.equal(bare.usr, 'smarterp_app');
  console.log(`  ✅ Outside ALS (Fail-Closed): db_user=${bare.usr}, comp="${bare.comp}", role="${bare.role}" (clean reset).`);

  const bypassRes = await storage.run({ bypassRls: true }, async () => {
    return pool.query(`
      SELECT 
        current_setting('app.bypass_rls', true) as bypass,
        current_user as usr;
    `);
  });
  assert.equal(bypassRes.rows[0].bypass, 'on');
  assert.equal(bypassRes.rows[0].usr, 'postgres');
  console.log(`  ✅ Explicit bypass ALS: db_user=${bypassRes.rows[0].usr}, bypass="${bypassRes.rows[0].bypass}".`);

  // Test 7: Rollback after failed queries
  console.log('\n[7/7] Testing transaction rollback after query error...');
  let failedAsExpected = false;
  const txClient = await pool.connect();
  try {
    await storage.run({ companyId: 1, userId: '00000000-0000-0000-0000-000000000001', role: 'owner' }, async () => {
      await txClient.query('BEGIN;');
      await txClient.query('SELECT 1;');
      await txClient.query('SELECT * FROM non_existent_table_for_rollback_test;');
      await txClient.query('COMMIT;');
    });
  } catch (err) {
    failedAsExpected = true;
    await txClient.query('ROLLBACK;').catch(() => {});
    console.log(`  Caught expected query error and rolled back: ${err.message}`);
  } finally {
    txClient.release();
  }
  assert.ok(failedAsExpected, 'Expected query on non-existent table to fail');

  // Verify connection pool is healthy and recovers immediately
  const recoveryRes = await pool.query('SELECT 1 as healthy;');
  assert.equal(recoveryRes.rows[0].healthy, 1);
  console.log('  ✅ Connection pool recovered immediately after rolled-back transaction.');

  console.log('\n===============================================================');
  console.log('🎉 ALL 7 TASK 5 SECURITY VERIFICATION INVARIANTS PASSED!');
  console.log('===============================================================\n');
}

runSecurityVerification()
  .then(() => pool.end())
  .catch(err => {
    console.error('❌ Security verification failed:', err);
    pool.end();
    process.exit(1);
  });
