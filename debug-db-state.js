const { pool } = require('./db');

async function debugDB() {
  try {
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    console.log('Tables:', tables.rows.map(r => r.table_name).join(', '));

    if (tables.rows.some(r => r.table_name === 'plans')) {
      const plans = await pool.query('SELECT * FROM plans');
      console.log('Plans:', plans.rows);
    } else {
      console.log('Plans table MISSING');
    }

    if (tables.rows.some(r => r.table_name === 'companies')) {
      const companies = await pool.query('SELECT id, company_id, company_name, plan_id FROM companies LIMIT 5');
      console.log('Companies (sample):', companies.rows);
    }

    if (tables.rows.some(r => r.table_name === 'users')) {
      const users = await pool.query('SELECT id, email, role, company_id FROM users');
      console.log('Users:', users.rows);
    }

  } catch (err) {
    console.error('Debug Error:', err.message);
  } finally {
    await pool.end();
  }
}

debugDB();
