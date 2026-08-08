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

function cleanConnectionString(url) {
  if (!url) return url;
  return url.replace(/sslmode=(prefer|require|verify-ca)/gi, 'sslmode=verify-full');
}

const pool = new Pool({
  connectionString: cleanConnectionString(process.env.DATABASE_URL),
  ssl: resolveSsl(),
  // Default pool max is intentionally low (5) to let Neon free-tier compute scale to zero.
  // Override with DB_POOL_MAX env var on paid plans or self-hosted Postgres.
  max: parseInt(process.env.DB_POOL_MAX || '10'),
  // Aggressive idle timeout so Neon compute can sleep between bursts of traffic.
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000'),
  connectionTimeoutMillis: 15000, // 15s connection queue timeout under load
  statement_timeout: 15000,      // 15s query safety limit
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err.message);
});

module.exports = { pool };
