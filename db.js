require("dotenv").config();
const { Pool } = require("pg");

const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: isProduction
    ? { rejectUnauthorized: false } // ✅ Render requires SSL
    : false,
});

pool
  .connect()
  .then(() =>
    console.log(
      `✅ Connected to PostgreSQL (${isProduction ? "Render Cloud" : "Local Docker"})`
    )
  )
  .catch((err) => console.error("❌ Database connection error:", err));

module.exports = { pool };
