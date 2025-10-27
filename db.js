const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ Connected to Neon PostgreSQL database");
    console.log("🕒 Database time:", res.rows[0].now);
  } catch (err) {
    console.error("❌ Database connection error:", err.message);
  }
})();

// ✅ Fix: Export an object with pool key
module.exports = { pool };
