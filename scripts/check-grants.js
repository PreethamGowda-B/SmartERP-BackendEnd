require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    // Check what privileges smarterp_app has on the tables we protect
    const privs = await client.query(`
      SELECT
        table_name,
        privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'smarterp_app'
        AND table_schema = 'public'
      ORDER BY table_name, privilege_type
    `);
    console.log('Current smarterp_app privileges:');
    if (privs.rows.length === 0) {
      console.log('  ⚠️  NO PRIVILEGES — need to GRANT table access to smarterp_app');
    } else {
      privs.rows.forEach(r => console.log(`  ${r.table_name}: ${r.privilege_type}`));
    }

    // Check if neondb_owner can SET ROLE to smarterp_app
    const membership = await client.query(`
      SELECT
        r.rolname AS member,
        m.rolname AS role
      FROM pg_roles r
      JOIN pg_auth_members am ON am.member = r.oid
      JOIN pg_roles m ON m.oid = am.roleid
      WHERE r.rolname = 'neondb_owner'
      ORDER BY m.rolname
    `);
    console.log('\nRoles neondb_owner is member of:');
    if (membership.rows.length === 0) {
      console.log('  ⚠️  Not a member of smarterp_app — SET ROLE will fail');
    } else {
      membership.rows.forEach(r => console.log(`  ${r.role}`));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
