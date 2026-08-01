const { pool } = require('../db');

async function inspectInvoices() {
  const res = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'invoices';
  `);
  console.log('📋 invoices columns:', res.rows);
  process.exit(0);
}

inspectInvoices().catch(err => { console.error(err); process.exit(1); });
