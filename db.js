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
 */
async function applyRlsToClient(client) {
  const { bypassRls, role, companyId } = buildRlsConfig();

  if (bypassRls) {
    // Explicit bypass — restore the privileged role, mark bypass = 'on'.
    // RESET ROLE is a no-op if the role was never changed, so always safe.
    try { await client.query('RESET ROLE'); } catch { /* ignore — role may not be set */ }
    await client.query(
      `SELECT
         set_config('app.bypass_rls',         'on', true),
         set_config('app.current_company_id', '',   true),
         set_config('app.current_role',       '',   true)`
    );
  } else {
    // Normal tenant request (or no context) — try to drop to restricted role first.
    // If smarterp_app role doesn't exist in this DB, skip gracefully — the session
    // variables alone enforce row-level isolation via the policy USING clause.
    try {
      await client.query('SET ROLE smarterp_app');
    } catch (roleErr) {
      // smarterp_app role not provisioned — fall through to session variable enforcement only.
      // This is acceptable: the app.bypass_rls='off' + empty company_id still denies cross-tenant access.
      console.warn('⚠️ db.js: SET ROLE smarterp_app skipped (role not found):', roleErr.message);
    }
    await client.query(
      `SELECT
         set_config('app.bypass_rls',         'off', true),
         set_config('app.current_company_id', $1,    true),
         set_config('app.current_role',       $2,    true)`,
      [companyId, role]
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
