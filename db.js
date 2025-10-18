require('dotenv').config();
const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: process.env.DB_PORT || 5432,
  ssl: isProduction
    ? { require: true, rejectUnauthorized: false } // ✅ Required for Neon
    : false,
});

pool.on('connect', () => {
  console.log('✅ Connected to Postgres DB');
});

pool.on('error', (err) => {
  console.error('❌ Postgres DB error:', err);
});

module.exports = pool;
