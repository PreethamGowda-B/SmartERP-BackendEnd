const { pool } = require('../db');

async function check() {
  const companies = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'companies' ORDER BY ordinal_position`
  );
  console.log('=== companies columns ===');
  companies.rows.forEach(r => console.log(r.column_name, '|', r.data_type));

  const plans = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'plans' ORDER BY ordinal_position`
  );
  console.log('\n=== plans columns ===');
  plans.rows.forEach(r => console.log(r.column_name, '|', r.data_type));

  const plansData = await pool.query('SELECT id, name, employee_limit FROM plans ORDER BY id');
  console.log('\n=== plans data ===');
  plansData.rows.forEach(r => console.log(r.id, r.name, r.employee_limit));

  process.exit(0);
}

check().catch(e => { console.error(e.message); process.exit(1); });
