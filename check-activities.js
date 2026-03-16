const { pool } = require('./db');
async function checkActivities() {
  try {
    const res = await pool.query("SELECT COUNT(*) FROM activities");
    console.log('Total activities:', res.rows[0].count);
    
    // Also check for index on created_at
    const indexRes = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'activities' AND indexdef LIKE '%created_at%'");
    console.log('Indexes on created_at:', indexRes.rows.map(r => r.indexname));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
checkActivities();
