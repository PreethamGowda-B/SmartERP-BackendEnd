/**
 * scripts/fix-superadmin-login.js
 *
 * One-time fix: Creates/updates admin@prozync.in with the correct password.
 * This script is safe to run multiple times.
 */

require('dotenv').config();
const { pool } = require('../db');
const bcrypt = require('bcrypt');

async function fixSuperAdminLogin() {
  const email = (process.env.SUPER_ADMIN_EMAIL || 'admin@prozync.in').toLowerCase().trim();
  const rawPassword = process.env.SUPER_ADMIN_PASSWORD || 'admin@preethu4959';

  try {
    console.log(`🔧 Fixing Super Admin login for: ${email}`);
    
    // Hash the password
    const hash = await bcrypt.hash(rawPassword, 12);
    console.log(`✅ Password hashed successfully`);
    
    // Check if user already exists with this email
    const existing = await pool.query('SELECT id, role, (password_hash IS NOT NULL) as has_password FROM users WHERE email = $1', [email]);
    
    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      // Update role to super_admin and set password
      await pool.query(
        "UPDATE users SET role = 'super_admin', password_hash = $1, name = COALESCE(NULLIF(name, ''), 'Prozync Platform Administrator') WHERE email = $2",
        [hash, email]
      );
      console.log(`✅ Updated existing user ${email} → role=super_admin, password set`);
    } else {
      // Create new super admin account
      await pool.query(
        "INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, 'super_admin', $3)",
        [email, hash, 'Prozync Platform Administrator']
      );
      console.log(`✅ Created new Super Admin account: ${email}`);
    }
    
    // Verify
    const verify = await pool.query('SELECT id, email, role, name, (password_hash IS NOT NULL) as has_password FROM users WHERE email = $1', [email]);
    console.log('\n📋 Verified Super Admin record:');
    console.log(JSON.stringify(verify.rows[0], null, 2));
    
    // Test password match
    const fullUser = await pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    const match = await bcrypt.compare(rawPassword, fullUser.rows[0].password_hash);
    console.log(`\n🔐 Password verification test: ${match ? '✅ PASS' : '❌ FAIL'}`);
    
    if (match) {
      console.log('\n🎉 Super Admin login fix complete!');
      console.log(`   Email: ${email}`);
      console.log(`   Password: ${rawPassword}`);
    }
    
  } catch (err) {
    console.error('❌ Fix failed:', err.message);
  } finally {
    await pool.end();
  }
}

fixSuperAdminLogin();
