require("dotenv").config();
const { Pool } = require("pg");

const isProduction = process.env.NODE_ENV === "production";

console.log("🧠 Database config:");
console.log({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  ssl: isProduction ? "enabled" : "disabled",
});

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

pool
  .connect()
  .then(() => console.log(`✅ Connected to PostgreSQL (Render Cloud)`))
  .catch((err) => console.error("❌ Database connection error:", err));

module.exports = { pool };
