const { pool } = require("../db-base");
const email = "testing495949@gmail.com";

async function find() {
  const r = await pool.query("SELECT company_id, role FROM users WHERE email = $1", [email]);
  console.log(r.rows[0]);
  process.exit();
}
find();
