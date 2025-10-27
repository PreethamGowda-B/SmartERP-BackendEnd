// back/db.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected DB error', err);
});

async function testConnection() {
  try {
    const res = await pool.query('SELECT NOW() as now');
    console.log('✅ Connected to Neon PostgreSQL database');
    console.log('🕒 Database time:', res.rows[0].now);
  } catch (err) {
    console.error('❌ DB connection test failed:', err);
  }
}
testConnection();

module.exports = { pool };
