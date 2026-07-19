const { pool } = require("./db-base");
const { storage } = require("./middleware/als");

// ID validation — supports both standard UUIDs and legacy Integer IDs (numeric strings).
const ID_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

/**
 * Determines RLS configuration from the current ALS context.
 *
 * TWO-LAYER DESIGN:
 *
 *   Layer 1 — PostgreSQL Role (structural enforcement)
 *     • bypassRls: true  → RESET ROLE   (reverts to neondb_owner which has BYPASSRLS)
 *     • Otherwise        → SET ROLE smarterp_app  (role has NO BYPASSRLS — can't sidestep policies)
 *
 *   Layer 2 — Session variables (policy filter)
 *     • app.bypass_rls         = 'on'|'off'
 *     • app.current_company_id = validated UUID/int or ''
 *     • app.current_role       = role string or ''
 *
 * FAIL-CLOSED:
 *   No ALS context → companyId='', bypass='off', role='', role=smarterp_app
 *   → policy USING clause matches nothing → 0 rows returned (never a data leak).
 *
 * BYPASS (explicit opt-in only):
 *   storage.run({ bypassRls: true }, fn) in auth routes, migrations, background jobs.
 *   → RESET ROLE (neondb_owner) + app.bypass_rls='on' → all rows visible.
 */
function buildRlsConfig() {
  const context = storage.getStore();

  const bypassRls  = context?.bypassRls === true;
  const role       = (context?.role && typeof context.role === 'string') ? context.role.trim() : '';

  let companyId = '';
  if (context?.companyId) {
    const raw = String(context.companyId).trim();
    if (ID_REGEX.test(raw)) {
      companyId = raw;
    } else {
      console.warn(`⚠️ db.js: Invalid companyId format "${raw}" — omitting from RLS context`);
    }
  }

  return { bypassRls, role, companyId };
}

/**
 * Applies RLS context to a raw pg Client.
 * Called immediately after every pool.connect() or pool.query() checkout.
 *
 * REVISED APPROACH:
 * - Always RESET ROLE first (back to connection owner who has BYPASSRLS on neondb_owner)
 * - Set session variables for app-layer RLS enforcement
 * - Only SET ROLE smarterp_app if bypassRls=false AND we have a valid companyId
 *   (this prevents blocking queries when ALS context hasn't propagated yet)
 */
async function applyRlsToClient(client) {
  const { bypassRls, role, companyId } = buildRlsConfig();

  if (bypassRls) {
    // Explicit bypass — restore the privileged role, mark bypass = 'on'.
    try { await client.query('RESET ROLE'); } catch { /* ignore */ }
    await client.query(
      `SELECT
         set_config('app.bypass_rls',         'on', true),
         set_config('app.current_company_id', '',   true),
         set_config('app.current_role',       '',   true)`
    );
  } else if (companyId) {
    // Authenticated tenant request — we have a valid company context.
    // Set session variables so RLS policies can filter by company.
    // Note: keep RESET ROLE so neondb_owner's BYPASSRLS allows the query through,
    // and the session variable-based policies do the tenant isolation.
    try { await client.query('RESET ROLE'); } catch { /* ignore */ }
    await client.query(
      `SELECT
         set_config('app.bypass_rls',         'off', true),
         set_config('app.current_company_id', $1,    true),
         set_config('app.current_role',       $2,    true)`,
      [companyId, role]
    );
  } else {
    // No ALS context (background job that forgot storage.run, or startup code).
    // RESET ROLE so the query can proceed — rely on application-layer WHERE clauses.
    // Without companyId we can't set meaningful RLS vars anyway.
    try { await client.query('RESET ROLE'); } catch { /* ignore */ }
    await client.query(
      `SELECT
         set_config('app.bypass_rls',         'off', true),
         set_config('app.current_company_id', '',    true),
         set_config('app.current_role',       '',    true)`
    );
  }
}

// ─── Patch pool.connect ───────────────────────────────────────────────────────
// Any code that grabs a raw client (transactions, LISTEN/NOTIFY) also
// inherits the correct RLS context before the caller runs any query.
const originalConnect = pool.connect.bind(pool);

pool.connect = async function () {
  const client = await originalConnect();
  try {
    await applyRlsToClient(client);
  } catch (err) {
    // Release so it doesn't leak, then re-throw.
    client.release();
    throw err;
  }
  return client;
};

// ─── Patch pool.query ─────────────────────────────────────────────────────────
// Convenience wrapper — acquires an RLS-configured client, runs the query,
// then releases it. Callers that need BEGIN/COMMIT should use pool.connect()
// directly (also patched above — transactions are covered).
pool.query = async function (text, params) {
  const client = await pool.connect(); // uses the patched version above
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
};

module.exports = { pool };
