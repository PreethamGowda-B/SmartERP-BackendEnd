/**
 * Try ALTER TABLE on a test table to understand what Neon permits
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const client = await pool.connect();
  try {
    // Check current role / session user
    const r1 = await client.query('SELECT current_user, session_user, pg_backend_pid()');
    console.log('Current session:', r1.rows[0]);

    // Check if we're actually running as neondb_owner
    const r2 = await client.query(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    );
    console.log('Current role details:', r2.rows[0]);

    // Try a minimal ALTER TABLE on a small table
    try {
      await client.query('ALTER TABLE jobs ENABLE ROW LEVEL SECURITY');
      console.log('✅ ALTER TABLE jobs ENABLE ROW LEVEL SECURITY succeeded');
    } catch (e) {
      console.error('❌ ALTER TABLE jobs ENABLE ROW LEVEL SECURITY failed:', e.message);
    }

    // Check if RLS is already enabled from a previous run
    const r3 = await client.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN ('jobs', 'payroll', 'inventory_items')
        AND relkind = 'r'
    `);
    console.log('RLS status:', r3.rows);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
