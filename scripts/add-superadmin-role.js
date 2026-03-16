const { pool } = require('../db');
require('dotenv').config();

async function addSuperAdminRole() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    console.log('🔄 Updating users_role_check constraint...');
    
    // Drop the old constraint
    await client.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
    
    // Add the new constraint with super_admin
    await client.query(`
      ALTER TABLE users ADD CONSTRAINT users_role_check 
      CHECK (role IN ('owner', 'employee', 'super_admin'))
    `);
    
    await client.query('COMMIT');
    console.log('✅ Success: users_role_check updated to allow super_admin');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to update constraint:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

addSuperAdminRole().catch((err) => { console.error(err); process.exit(1); });
