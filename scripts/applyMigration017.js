const { pool } = require('../db');
const fs = require('fs');
const path = require('path');

async function applyMigration() {
  console.log('⚡ Executing 017_enterprise_rbac_and_state_machine.sql against database...');
  try {
    const sqlPath = path.join(__dirname, '../migrations/017_enterprise_rbac_and_state_machine.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
    console.log('✅ Migration 017 executed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration 017 execution error:', err);
    process.exit(1);
  }
}

applyMigration();
