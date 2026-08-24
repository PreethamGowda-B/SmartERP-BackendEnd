const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const { Pool } = require('pg');
require('dotenv').config();

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
  // Automatically rewrite IPv6-only direct Supabase host to verified IPv4 Pooler host for Render compatibility
  const supabaseDirectMatch = url.match(/postgresql:\/\/postgres(?:\.([a-z0-9]+))?:([^@]+)@db\.([a-z0-9]+)\.supabase\.co(?::\d+)?\/(.+)/i);
  if (supabaseDirectMatch) {
    const projectRef = supabaseDirectMatch[3] || supabaseDirectMatch[1];
    const password = supabaseDirectMatch[2];
    const dbPath = supabaseDirectMatch[4];
    url = `postgresql://postgres.${projectRef}:${password}@aws-0-ap-northeast-1.pooler.supabase.com:6543/${dbPath}`;
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
  // Default pool max is 10 connections
  max: parseInt(process.env.DB_POOL_MAX || '10'),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000'),
  connectionTimeoutMillis: 15000, // 15s connection queue timeout under load
  statement_timeout: 15000,      // 15s query safety limit
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err.message);
});

module.exports = { pool };
