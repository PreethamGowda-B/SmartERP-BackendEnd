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
 *     • app.current_user_id    = validated UUID or ''
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
function buildRlsConfig(context = storage.getStore()) {

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

  const candidateUserId = context?.userId == null ? '' : String(context.userId).trim();
  const userId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidateUserId)
    ? candidateUserId
    : '';

  return { bypassRls, role, companyId, userId };
}

/**
 * Applies RLS context to a raw pg Client.
 * Called immediately after every pool.connect() or pool.query() checkout.
 *
 * REVISED APPROACH:
 * - Always RESET ROLE first (back to connection owner who has BYPASSRLS on neondb_owner)
 * - Set all session variables (including empty values) on every pool checkout.
 * - Use the non-superuser app role for every non-bypass request, including requests
 *   with missing tenant context. RLS then returns no rows instead of running as the
 *   database owner, which may bypass RLS.
 */
async function applyRlsToClient(client, context = storage.getStore()) {
  const { bypassRls, role, companyId, userId } = buildRlsConfig(context);
  const safeRole = String(role || '').replace(/[^a-zA-Z0-9_-]/g, '');

  // Separate statements keep parameter binding safe and make failures explicit.
  await client.query('RESET ROLE');
  await client.query(
    `SELECT set_config('app.bypass_rls', $1, false),
            set_config('app.current_company_id', $2, false),
            set_config('app.current_role', $3, false),
            set_config('app.current_user_id', $4, false)`,
    [bypassRls ? 'on' : 'off', companyId, safeRole, userId]
  );
  if (!bypassRls) {
    // Failure must abort checkout. Falling back to the database owner could bypass RLS.
    await client.query('SET ROLE smarterp_app');
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

module.exports = { pool, buildRlsConfig, applyRlsToClient };
