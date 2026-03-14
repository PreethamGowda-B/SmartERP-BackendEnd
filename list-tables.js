const { pool } = require('./db');
async function list() {
  const r = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  console.table(r.rows);
  process.exit(0);
}
list();
