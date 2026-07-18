require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('RESET ROLE');
    // Sample distinct company_ids in the jobs table
    const r1 = await client.query('SELECT DISTINCT company_id FROM jobs LIMIT 10');
    console.log('Distinct company_ids in jobs:', r1.rows.map(r => r.company_id));

    // Sample company IDs from companies table
    const r2 = await client.query('SELECT id, name FROM companies LIMIT 5');
    console.log('Companies table:', r2.rows);

    // Check jobs column type
    const r3 = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='jobs' AND column_name='company_id'"
    );
    console.log('jobs.company_id type:', r3.rows);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
