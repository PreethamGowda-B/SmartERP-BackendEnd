const { Pool } = require('pg');
require('dotenv').config();

// SSL configuration driven by explicit env vars rather than URL string matching.
// DB_SSL=true  → verify certificate (production, recommended)
// DB_SSL=no-verify → encrypted but skip cert check (some managed DBs)
// DB_SSL=false or unset → no SSL (local dev)
// When DATABASE_URL contains 'sslmode=disable' we always honour that and skip SSL.
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
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err.message);
});

module.exports = { pool };
