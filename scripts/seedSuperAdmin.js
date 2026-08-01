/**
 * scripts/seedSuperAdmin.js
 *
 * Automatic seeding/verification of platform Super Admin account.
 * Runs during database initialization.
 *
 * IMPORTANT: Checks by EMAIL specifically, not by role.
 * This ensures admin@prozync.in is always created even if
 * another super_admin (e.g. Google OAuth user) already exists.
 */

const { pool } = require('../db');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function seedSuperAdmin() {
  try {
    const email = (process.env.SUPER_ADMIN_EMAIL || 'admin@prozync.in').toLowerCase().trim();
    const rawPassword = process.env.SUPER_ADMIN_PASSWORD || 'admin@preethu4959';

    // ✅ Check by EMAIL specifically — not by role — so we don't skip if a
    //    different super_admin (e.g. Google OAuth account) already exists.
    const existing = await pool.query('SELECT id, role, password_hash FROM users WHERE email = $1', [email]);

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      const needsRoleUpdate = user.role !== 'super_admin';
      const needsPasswordSet = !user.password_hash;

      if (needsRoleUpdate || needsPasswordSet) {
        const hash = needsPasswordSet ? await bcrypt.hash(rawPassword, 12) : user.password_hash;
        await pool.query(
          "UPDATE users SET role = 'super_admin', password_hash = $1 WHERE email = $2",
          [hash, email]
        );
        console.log(`🛡️ Updated Super Admin account (${email}): role=${needsRoleUpdate ? 'fixed' : 'ok'}, password=${needsPasswordSet ? 'set' : 'ok'}`);
      } else {
        console.log(`🛡️ Super Admin account (${email}) ready`);
      }
    } else {
      const hash = await bcrypt.hash(rawPassword, 12);
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
