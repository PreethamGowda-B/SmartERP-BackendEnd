const { Pool } = require('pg');
require('dotenv').config();

// SSL configuration driven by explicit env vars rather than URL string matching.
function resolveSsl() {
  if (process.env.DATABASE_URL?.includes('sslmode=disable')) return false;
  const flag = (process.env.DB_SSL || '').toLowerCase();
  if (flag === 'true') return { rejectUnauthorized: true };
  if (flag === 'no-verify') return { rejectUnauthorized: false };
  return false;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSsl(),
  max: parseInt(process.env.DB_POOL_MAX || '25'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000, // Faster timeout to fail fast under overload
  statement_timeout: 10000,       // 10s query safety limit to prevent deadlocks
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err.message);
});

module.exports = { pool };
