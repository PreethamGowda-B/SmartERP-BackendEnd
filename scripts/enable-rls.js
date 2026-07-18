/**
 * Apply ENABLE ROW LEVEL SECURITY to all target tables and drop old conflicting policies.
 * Uses raw pool (no db.js patches) and RESET ROLE for DDL rights.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const tables = [
  'inventory_items', 'payroll', 'jobs', 'attendance', 'notifications',
  'material_requests', 'messages', 'job_messages', 'employee_documents',
  'customers', 'conversations', 'employee_profiles', 'activities',
  'company_settings', 'sla_configs', 'invoices', 'job_materials', 'branches'
];

// Old policies that may conflict (leftover from previous migration attempts)
const oldPolicies = [
  { table: 'jobs', policy: 'jobs_isolation_policy' },
  { table: 'payroll', policy: 'payroll_isolation_policy' },
  { table: 'attendance', policy: 'attendance_isolation' },
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('RESET ROLE');
    console.log('Running as:', (await client.query('SELECT current_user')).rows[0].current_user);

    // 1. Drop old conflicting policies
    console.log('\n--- Dropping old conflicting policies ---');
    for (const { table, policy } of oldPolicies) {
      try {
        await client.query(`DROP POLICY IF EXISTS "${policy}" ON ${table}`);
        console.log(`  ✅  Dropped ${policy} from ${table}`);
      } catch (e) {
        console.error(`  ❌  ${table}.${policy}: ${e.message}`);
      }
    }

    // 2. ENABLE ROW LEVEL SECURITY on all tables
    console.log('\n--- Enabling RLS on all tables ---');
    for (const table of tables) {
      try {
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        console.log(`  ✅  ${table}: ENABLE ROW LEVEL SECURITY`);
      } catch (e) {
        console.error(`  ❌  ${table}: ${e.message}`);
      }
    }

    // 3. Verify final state
    console.log('\n--- Verification ---');
    const r = await client.query(`
      SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class
      WHERE relname = ANY($1) AND relkind = 'r'
      ORDER BY relname
    `, [tables]);
    r.rows.forEach(row => {
      const en = row.enabled ? '✅' : '❌';
      const fo = row.forced ? '✅' : '❌';
      console.log(`  ${en} enabled  ${fo} forced  ${row.relname}`);
    });

    // 4. Check policies
    const r2 = await client.query(`
      SELECT tablename, policyname FROM pg_policies
      WHERE tablename = ANY($1) ORDER BY tablename, policyname
    `, [tables]);
    console.log('\nActive policies:');
    r2.rows.forEach(r => console.log(`  ${r.tablename}: ${r.policyname}`));

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
