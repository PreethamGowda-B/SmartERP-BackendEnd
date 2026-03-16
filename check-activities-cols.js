const { pool } = require('./db');
async function checkActivities() {
  try {
    const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'activities'");
    console.log(res.rows.map(r => r.column_name));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
checkActivities();
