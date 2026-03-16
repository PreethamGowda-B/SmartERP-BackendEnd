const { pool } = require('../db');
require('dotenv').config();

async function checkUser() {
  const email = process.env.SUPER_ADMIN_EMAIL || 'prozyncinnovations@gmail.com';
  console.log(`Checking user: ${email}`);
  
  const res = await pool.query('SELECT id, email, role, company_id FROM users WHERE email = $1', [email]);
  if (res.rows.length === 0) {
    console.log('❌ User not found');
  } else {
    console.log('✅ User found:', JSON.stringify(res.rows[0], null, 2));
  }
  process.exit(0);
}

checkUser().catch((err) => { console.error(err); process.exit(1); });
