require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

pool.query(
  "SELECT tableowner, tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LIMIT 10"
).then(r => {
  console.log('Table owners:');
  r.rows.forEach(row => console.log(`  ${row.tableowner} → ${row.tablename}`));
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
