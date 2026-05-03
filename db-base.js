const { Pool } = require('pg');
require('dotenv').config();

// Suppress pg-connection-string SSL deprecation warning by explicitly setting ssl option.
// The warning fires when DATABASE_URL contains 'sslmode=require' (or prefer/verify-ca).
// We override with rejectUnauthorized: false which matches the previous 'require' behavior.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=disable')
    ? false
    : process.env.DATABASE_URL?.includes('ssl') || process.env.DATABASE_URL?.includes('postgres')
    ? { rejectUnauthorized: false }
    : false,
  max: parseInt(process.env.DB_POOL_MAX || "50", 10),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  maxUses: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err.message);
});

module.exports = { pool };
