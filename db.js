const { Pool } = require("pg");
require("dotenv").config();

// ✅ Always prefer DATABASE_URL (Neon or Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ Test connection immediately
(async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ Connected to Neon PostgreSQL database");
    console.log("🕒 Database time:", res.rows[0].now);
  } catch (err) {
    console.error("❌ Database connection error:", err.message);
  }
})();

module.exports = pool;
