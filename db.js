const { Pool } = require("pg");
require("dotenv").config();

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: parseInt(process.env.DB_MAX_CONNECTIONS || "50"), // Support higher limits via env
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Faster failure for high-concurrency
};

const pool = new Pool(poolConfig);

// Test DB connection
(async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ Connected to Neon PostgreSQL database");
    console.log("🕒 Database time:", res.rows[0].now);
  } catch (err) {
    console.error("❌ Database connection error:", err.message);
  }
})();

// ✅ Correctly export
module.exports = { pool };
