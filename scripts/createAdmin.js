const { pool } = require('../db');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function createAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const role = 'owner';

  const hash = await bcrypt.hash(password, 10);
  const res = await pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role', [email, hash, role]);
  console.log('Created admin user:', res.rows[0]);
  process.exit(0);
}

createAdmin().catch((err) => { console.error(err); process.exit(1); });
