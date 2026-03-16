const { pool } = require('../db');
require('dotenv').config();

async function promoteToSuperAdmin() {
  const email = process.env.SUPER_ADMIN_EMAIL || 'prozyncinnovations@gmail.com';
  console.log(`Promoting user: ${email} to super_admin`);
  
  const res = await pool.query(
    "UPDATE users SET role = 'super_admin' WHERE email = $1 RETURNING id, email, role",
    [email]
  );
  
  if (res.rows.length === 0) {
    console.log('❌ User not found');
  } else {
    console.log('✅ User promoted:', JSON.stringify(res.rows[0], null, 2));
  }
  process.exit(0);
}

promoteToSuperAdmin().catch((err) => { console.error(err); process.exit(1); });
