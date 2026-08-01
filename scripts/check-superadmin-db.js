require('dotenv').config();
const { pool } = require('../db');
const bcrypt = require('bcrypt');

async function main() {
  try {
    // Check existing super admin records
    const result = await pool.query(
      "SELECT id, email, role, name, (password_hash IS NOT NULL) as has_password FROM users WHERE email LIKE '%admin%' OR role = 'super_admin'"
    );
    console.log('Super Admin Records:', JSON.stringify(result.rows, null, 2));
    
    // If exists, test password match
    if (result.rows.length > 0) {
      for (const user of result.rows) {
        if (user.has_password) {
          const fullUser = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
          const testPassword = process.env.SUPER_ADMIN_PASSWORD || 'admin@preethu4959';
          const match = await bcrypt.compare(testPassword, fullUser.rows[0].password_hash);
          console.log(`Password match for ${user.email}: ${match}`);
        }
      }
    }
    
    // Check what email the seed would use
    const seedEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@prozync.in').toLowerCase().trim();
    console.log('Seed script email:', seedEmail);
    console.log('Seed script password:', process.env.SUPER_ADMIN_PASSWORD || 'admin@preethu4959');
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

main();
