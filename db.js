const { Pool } = require("pg");
require("dotenv").config();

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: parseInt(process.env.DB_MAX_CONNECTIONS || "20"), // Reduced default to avoid hitting Neon limits too fast
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000, // Slightly more generous for startup spikes
};

const pool = new Pool(poolConfig);

// DB connection pool event handling
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// ✅ Tenant-aware query helper for RLS
async function tenantQuery(sql, params, companyId) {
  const client = await pool.connect();
  try {
    if (companyId) {
      await client.query(`SET LOCAL app.current_company_id = '${companyId}'`);
    }
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// ✅ Correctly export
module.exports = { pool, tenantQuery };
