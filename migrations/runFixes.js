const { pool } = require('../db');
const fs = require('fs');
const path = require('path');

async function runFixes() {
  try {
    const sqlPath = path.join(__dirname, '20260316_superadmin_fixes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('Running Superadmin fixes...');
    await pool.query(sql);
    console.log('✅ Superadmin fixes applied successfully.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to apply Superadmin fixes:', err.message);
    process.exit(1);
  }
}

runFixes();
