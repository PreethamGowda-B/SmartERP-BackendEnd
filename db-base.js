const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const { Pool } = require('pg');
require('dotenv').config();

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

function cleanConnectionString(url) {
  if (!url) return url;
// Rewrite the IPv6-only direct Supabase host to the IPv4 session pooler for Render.
// This backend relies on session-scoped SET ROLE and app.* RLS settings between
// statements, so the transaction pooler (6543) is not compatible; use session
// mode (5432) to keep those settings on the same PostgreSQL connection.
  const supabaseDirectMatch = url.match(/postgresql:\/\/postgres(?:\.([a-z0-9]+))?:([^@]+)@db\.([a-z0-9]+)\.supabase\.co(?::\d+)?\/(.+)/i);
  if (supabaseDirectMatch) {
    const projectRef = supabaseDirectMatch[3] || supabaseDirectMatch[1];
    const password = supabaseDirectMatch[2];
    const dbPath = supabaseDirectMatch[4];
    url = `postgresql://postgres.${projectRef}:${password}@aws-0-ap-northeast-1.pooler.supabase.com:5432/${dbPath}`;
  }
  return url.replace(/sslmode=(prefer|require|verify-ca)/gi, 'sslmode=verify-full');
}

const ipv4Lookup = (hostname, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = { family: 4 };
  } else if (typeof options === 'number') {
    options = { family: 4 };
  } else {
    options = Object.assign({}, options, { family: 4 });
  }
  return dns.lookup(hostname, options, callback);
};

const pool = new Pool({
  connectionString: cleanConnectionString(process.env.DATABASE_URL),
  ssl: resolveSsl(),
  lookup: ipv4Lookup,
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
