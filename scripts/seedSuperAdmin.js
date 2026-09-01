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
    const superAdminAccounts = [
      {
        email: 'prozyncinnovations@gmail.com',
        password: process.env.SUPER_ADMIN_PASSWORD || 'Preethu@4959',
        name: 'Pro Zync'
      },
      {
        email: 'admin@prozync.in',
        password: process.env.SUPER_ADMIN_PASSWORD || 'Preethu@4959',
        name: 'Prozync Platform Administrator'
      }
    ];

    if (process.env.SUPER_ADMIN_EMAIL && !superAdminAccounts.some(a => a.email === process.env.SUPER_ADMIN_EMAIL.toLowerCase().trim())) {
      superAdminAccounts.push({
        email: process.env.SUPER_ADMIN_EMAIL.toLowerCase().trim(),
        password: process.env.SUPER_ADMIN_PASSWORD || 'Preethu@4959',
        name: 'Custom Super Admin'
      });
    }

    for (const acc of superAdminAccounts) {
      const email = acc.email.toLowerCase().trim();
      const rawPassword = acc.password;

      const existing = await pool.query('SELECT id, role, password_hash, is_active FROM users WHERE LOWER(email) = $1', [email]);

      if (existing.rows.length > 0) {
        const user = existing.rows[0];
        const needsRoleUpdate = user.role !== 'super_admin';
        const needsActiveUpdate = !user.is_active;
        let passwordMatch = false;

        if (user.password_hash) {
          try {
            passwordMatch = await bcrypt.compare(rawPassword, user.password_hash);
          } catch (e) {
            passwordMatch = false;
          }
        }

        if (needsRoleUpdate || needsActiveUpdate || !passwordMatch) {
          const hash = await bcrypt.hash(rawPassword, 12);
          await pool.query(
            "UPDATE users SET role = 'super_admin', is_active = TRUE, password_set = TRUE, password_hash = $1 WHERE LOWER(email) = $2",
            [hash, email]
          );
          console.log(`🛡️ Updated Super Admin account (${email}): role=${needsRoleUpdate ? 'fixed' : 'ok'}, password=${!passwordMatch ? 'reset' : 'ok'}`);
        } else {
          console.log(`🛡️ Super Admin account (${email}) ready & verified`);
        }
      } else {
        const hash = await bcrypt.hash(rawPassword, 12);
        await pool.query(
          "INSERT INTO users (email, password_hash, role, name, is_active, password_set) VALUES ($1, $2, 'super_admin', $3, TRUE, TRUE)",
          [email, hash, acc.name]
        );
        console.log(`🛡️ Created platform Super Admin account (${email})`);
      }
    }
  } catch (err) {
    console.warn('⚠️ Super Admin seeding skipped:', err.message);
  }
}

module.exports = { seedSuperAdmin };
