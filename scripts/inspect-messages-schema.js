const { pool } = require('../db');

async function inspectTables() {
  const res = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'messages';
  `);
  console.log('📋 messages columns:', res.rows);
  
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
  `);
  console.log('📋 Existing public tables:', tables.rows.map(r => r.table_name));
  
  process.exit(0);
}

inspectTables().catch(err => { console.error(err); process.exit(1); });
