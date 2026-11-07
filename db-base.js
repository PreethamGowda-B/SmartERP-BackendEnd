const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const { Pool } = require('pg');
require('dotenv').config();
const { cleanConnectionString } = require('./utils/databaseUrl');

const DEFAULT_DB_POOL_MAX = 2;

function resolvePoolMax(value = process.env.DB_POOL_MAX) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DB_POOL_MAX;
}

// SSL configuration driven by explicit env vars rather than URL string matching.
function resolveSsl() {
  if (process.env.DATABASE_URL?.includes('sslmode=disable')) return false;
  const flag = (process.env.DB_SSL || '').toLowerCase();
  if (flag === 'true') return { rejectUnauthorized: true };
  if (flag === 'no-verify') return { rejectUnauthorized: false };
  // Default to SSL for Supabase/Neon/cloud database providers
  if (process.env.DATABASE_URL?.includes('supabase') || process.env.DATABASE_URL?.includes('neon')) {
    return { rejectUnauthorized: false };
  }
  return false;
}

const pool = new Pool({
  connectionString: cleanConnectionString(process.env.DATABASE_URL),
  ssl: resolveSsl(),
  // pg Pool is process-local. With two web workers per Render instance, a
  // default of two keeps the app to four sessions per instance and leaves
  // more room under the shared Supabase session-pool limit. Override only
  // after sizing every process and service instance using the same database.
  max: resolvePoolMax(),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000', 10),
  connectionTimeoutMillis: 10000, // 10s connection queue timeout under load
  statement_timeout: 15000,       // 15s query safety limit
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err.message);
});

module.exports = { pool, cleanConnectionString, resolvePoolMax, DEFAULT_DB_POOL_MAX };
