const { pool } = require('../db');

async function inspectCompanies() {
  const res = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'companies';
  `);
  console.log('📋 companies columns:', res.rows);
  process.exit(0);
}

inspectCompanies().catch(err => { console.error(err); process.exit(1); });
