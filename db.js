require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: process.env.DB_PORT || 5432,
  ssl: false, // Render Postgres does NOT require SSL
});

pool.on('connect', () => {
  console.log('✅ Connected to Postgres DB');
});

pool.on('error', (err) => {
  console.error('❌ Postgres DB error:', err);
});

module.exports = pool;
