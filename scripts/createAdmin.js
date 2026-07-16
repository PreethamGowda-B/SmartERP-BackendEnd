const { pool } = require('../db');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function createAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('❌ ADMIN_EMAIL and ADMIN_PASSWORD must be set. Refusing to create admin with defaults.');
    process.exit(1);
  }

  if (password.length < 12) {
    console.error('❌ ADMIN_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }

  const role = 'owner';

  const hash = await bcrypt.hash(password, 10);
  const res = await pool.query('INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, $3, $4) RETURNING id, email, role', [email, hash, role, 'Admin User']);
  console.log('Created admin user:', res.rows[0]);
  process.exit(0);
}

createAdmin().catch((err) => { console.error(err); process.exit(1); });
