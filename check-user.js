const { pool } = require('./db');

async function checkUser(email) {
  try {
    const result = await pool.query('SELECT id, email, role, company_id FROM users WHERE email = $1', [email]);
    if (result.rows.length > 0) {
      console.log('FOUND:', JSON.stringify(result.rows[0], null, 2));
    } else {
      console.log('NOT FOUND');
    }
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
}

checkUser('testing4959@gmail.com');
