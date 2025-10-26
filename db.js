const { Pool } = require("pg");
require("dotenv").config();

// ✅ Supports both Render and Neon DB setups
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  ssl: {
    rejectUnauthorized: false, // Required for Render
  },
});

// ✅ Test the connection immediately
(async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ Connected to PostgreSQL (Render Cloud)");
    console.log("🕒 Database time:", res.rows[0].now);
  } catch (err) {
    console.error("❌ PostgreSQL connection error:", err.message);
  }
})();

module.exports = pool;
