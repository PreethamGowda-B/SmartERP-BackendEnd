const { pool } = require('../db');
require('dotenv').config();

async function addHRRole() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    console.log('🔄 Updating users_role_check constraint to include "hr"...');
    
    // Drop the old constraint
    await client.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
    
    // Add the new constraint with owner, employee, super_admin, and hr
    await client.query(`
      ALTER TABLE users ADD CONSTRAINT users_role_check 
      CHECK (role IN ('owner', 'employee', 'super_admin', 'hr'))
    `);
    
    await client.query('COMMIT');
    console.log('✅ Success: users_role_check updated to allow "hr" role');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to update constraint:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

addHRRole().catch((err) => { console.error(err); process.exit(1); });
