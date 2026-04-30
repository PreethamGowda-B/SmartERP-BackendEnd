const { pool } = require("./db-base");
const { storage } = require("./middleware/als");

// Store the original query function
const originalQuery = pool.query.bind(pool);

// UUID validation regex — companyId comes from JWT payload but we validate
// before interpolating into SQL to prevent any injection risk.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Validate companyId is a proper UUID before using it in SQL.
  // This prevents any injection even though the value comes from a JWT.
  if (!UUID_REGEX.test(companyId)) {
    console.warn(`⚠️ setTenantContext: Invalid companyId format "${companyId}" — skipping RLS context`);
    return originalQuery(text, params);
  }

  const client = await pool.connect();
  try {
    // Use parameterized SET to avoid any string interpolation risk
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_company_id',
      companyId,
    ]);
    return await client.query(text, params);
  } finally {
    client.release();
  }
};

module.exports = { pool };
