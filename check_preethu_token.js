const { pool } = require('./db');
async function check() {
  try {
    const res = await pool.query("SELECT id, name, email, role, push_token FROM users WHERE name ILIKE '%Preethu%'");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    process.exit();
  }
}
check();
