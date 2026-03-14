const { pool } = require("./db-base");
const { storage } = require("./middleware/als");

// Store the original query function
const originalQuery = pool.query.bind(pool);

/**
 * Global query wrapper that enforces Row-Level Security (RLS)
 * by pulling the companyId from AsyncLocalStorage.
 * We monkey-patch pool.query so existing code works perfectly.
 */
pool.query = async function(text, params) {
  const context = storage.getStore();
  const companyId = context?.companyId;

  // Use standard query if no companyId (e.g. public routes, startup)
  if (!companyId) {
    return originalQuery(text, params);
  }

  const client = await pool.connect();
  try {
    // Set the session variable for RLS
    await client.query(`SET LOCAL app.current_company_id = '${companyId}'`);
    return await client.query(text, params);
  } finally {
    client.release();
  }
};

module.exports = { pool };
