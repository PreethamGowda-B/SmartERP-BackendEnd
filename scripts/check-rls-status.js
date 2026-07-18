require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('RESET ROLE');
    
    // Check RLS status for all tables
    const r = await client.query(`
      SELECT
        relname,
        relrowsecurity AS rls_enabled,
        relforcerowsecurity AS rls_forced
      FROM pg_class
      WHERE relname IN (
        'jobs','payroll','attendance','notifications','inventory_items',
        'material_requests','messages','job_messages','employee_documents',
        'customers','conversations','employee_profiles','activities',
        'company_settings','sla_configs','invoices','job_materials','branches'
      )
      AND relkind = 'r'
      ORDER BY relname
    `);
    
    console.log('RLS status per table:');
    r.rows.forEach(row => {
      const status = row.rls_enabled ? '✅ ON' : '❌ OFF';
      const forced = row.rls_forced ? ' (FORCED)' : '';
      console.log(`  ${status}${forced}  ${row.relname}`);
    });
    
    // Also check policies
    const r2 = await client.query(`
      SELECT schemaname, tablename, policyname
      FROM pg_policies
      WHERE tablename IN ('jobs','payroll','attendance')
      ORDER BY tablename
    `);
    console.log('\nPolicies on jobs/payroll/attendance:');
    r2.rows.forEach(row => console.log(`  ${row.tablename}: ${row.policyname}`));
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
