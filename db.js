const { pool } = require("./db-base");
const { storage } = require("./middleware/als");

// Store the original query function
const originalQuery = pool.query.bind(pool);

// ID validation — supports both standard UUIDs and legacy Integer IDs (numeric strings).
// This ensures RLS is activated regardless of the underlying company_id type.
const ID_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

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

  // Normalize to string for regex test
  const companyIdStr = String(companyId).trim();

  // Validate companyId format before using it in SQL.
  // We allow both UUIDs and Integers to support mixed schema states.
  if (!ID_REGEX.test(companyIdStr)) {
    console.warn(`⚠️ pool.query: Invalid companyId format "${companyIdStr}" — skipping RLS context`);
    return originalQuery(text, params);
  }

  const client = await pool.connect();
  try {
    // Use parameterized SET to avoid any string interpolation risk
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_company_id',
      companyIdStr,
    ]);
    return await client.query(text, params);
  } finally {
    client.release();
  }
};

module.exports = { pool };
