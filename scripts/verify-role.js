require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    // Set role to smarterp_app (no BYPASSRLS)
    await client.query('SET ROLE smarterp_app');

    // Check if current user now has BYPASSRLS = false
    const result = await client.query(
      'SELECT CURRENT_USER, rolbypassrls FROM pg_roles WHERE rolname = CURRENT_USER'
    );
    console.log('After SET ROLE smarterp_app:', result.rows);

    // Reset back to original role
    await client.query('RESET ROLE');
    const result2 = await client.query(
      'SELECT CURRENT_USER, rolbypassrls FROM pg_roles WHERE rolname = CURRENT_USER'
    );
    console.log('After RESET ROLE:', result2.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
