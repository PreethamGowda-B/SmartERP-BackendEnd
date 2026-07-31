/**
 * scripts/seedSuperAdmin.js
 *
 * Automatic seeding/verification of platform Super Admin account.
 * Runs during database initialization.
 */

const { pool } = require('../db');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function seedSuperAdmin() {
  try {
    const email = (process.env.SUPER_ADMIN_EMAIL || 'admin@prozync.in').toLowerCase().trim();
    const rawPassword = process.env.SUPER_ADMIN_PASSWORD || 'admin@preethu4959';

    // Check if user already exists
    const existing = await pool.query('SELECT id, role, password_hash FROM users WHERE email = $1', [email]);

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      if (user.role !== 'super_admin') {
        await pool.query("UPDATE users SET role = 'super_admin' WHERE email = $1", [email]);
        console.log(`🛡️ Promoted existing user ${email} to super_admin`);
      } else {
        console.log(`🛡️ Super Admin account (${email}) ready`);
      }
    } else {
      const hash = await bcrypt.hash(rawPassword, 10);
      await pool.query(
        "INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, 'super_admin', $3)",
        [email, hash, 'Prozync Platform Administrator']
      );
      console.log(`🛡️ Created platform Super Admin account (${email})`);
    }
  } catch (err) {
    console.warn('⚠️ Super Admin seeding skipped:', err.message);
  }
}

module.exports = { seedSuperAdmin };
