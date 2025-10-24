const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    require: true,
    rejectUnauthorized: false, // Required for Neon/Render SSL
  },
});

pool.connect()
  .then(() => console.log("✅ Connected to PostgreSQL (Neon)"))
  .catch((err) => console.error("❌ Database connection error:", err));

module.exports = pool;
