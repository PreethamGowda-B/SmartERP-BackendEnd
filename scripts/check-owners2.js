require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const tables = [
  'material_requests', 'messages', 'job_messages', 'employee_documents',
  'inventory_items', 'payroll', 'jobs', 'attendance', 'notifications'
];

pool.query(
  `SELECT tableowner, tablename FROM pg_tables WHERE tablename = ANY($1) AND schemaname = 'public'`,
  [tables]
).then(r => {
  console.log('Ownership of RLS target tables:');
  r.rows.forEach(row => console.log(`  ${row.tableowner} → ${row.tablename}`));
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
