const { Pool } = require("pg");
require("dotenv").config();

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true, sslmode: 'verify-full' }, // Explicitly set for new pg versions
  max: parseInt(process.env.DB_MAX_CONNECTIONS || "20"), // Reduced default to avoid hitting Neon limits too fast
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000, // Slightly more generous for startup spikes
};

const pool = new Pool(poolConfig);

// DB connection pool event handling
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// ✅ Correctly export
module.exports = { pool };
