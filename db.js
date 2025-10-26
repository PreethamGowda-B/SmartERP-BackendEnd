// backend/db.js
const { Pool } = require("pg");
require("dotenv").config();

// ✅ Use DATABASE_URL (Neon/Render) for production
// ✅ Use local .env values only if DATABASE_URL is not defined
let pool;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  console.log("🌐 Using remote Neon/Render PostgreSQL database");
} else {
  pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
  });
  console.log("💻 Using local PostgreSQL database");
}

// ✅ Test connection immediately on startup
(async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ Connected to PostgreSQL database");
    console.log("🕒 Database time:", res.rows[0].now);
  } catch (err) {
    console.error("❌ Database connection error:", err.message);
  }
})();

module.exports = { pool };
