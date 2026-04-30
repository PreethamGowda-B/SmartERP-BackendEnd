const { pool } = require('../db');

async function cleanup() {
  try {
    console.log('🧹 Starting database cleanup...');
    const result = await pool.query(`
      UPDATE jobs 
      SET assigned_to = NULL 
      WHERE employee_status = 'assigned' 
      AND status = 'open'
    `);
    console.log(`✅ Cleanup complete. Updated ${result.rowCount} jobs.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Cleanup failed:', err.message);
    process.exit(1);
  }
}

cleanup();
