const { pool } = require("./db-base");
const { storage } = require("./middleware/als");
const { performance } = require("node:perf_hooks");
const logger = require("./utils/logger");

// Configurable slow query and pool acquisition thresholds for production performance alerts
const SLOW_QUERY_THRESHOLD_MS = Number(process.env.SLOW_QUERY_THRESHOLD_MS || process.env.DB_SLOW_QUERY_THRESHOLD_MS || 2000);
const POOL_ACQUIRE_WARN_MS = Number(process.env.POOL_ACQUIRE_WARN_MS || 1000);

function recordDbStage(stage, durationMs, details = {}) {
  const context = storage.getStore();
  const requestId = context?.requestId || null;
  const duration = Number(durationMs.toFixed(2));

  // Slow query warning: only emitted when actual SQL execution exceeds the configured threshold
  if (stage === "sql_execution" && durationMs >= SLOW_QUERY_THRESHOLD_MS) {
    const operation = details.sql ? details.sql.slice(0, 150) : "query";
    logger.slowQuery(operation, durationMs, {
      requestId,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    });
    return;
  }

  // Connection pool contention alert: emitted when pool checkout is slow or requests are queued
  if (stage === "pool_acquire" && (durationMs >= POOL_ACQUIRE_WARN_MS || pool.waitingCount > 0)) {
    logger.warn("Database connection pool contention detected", {
      type: "pool_contention",
      acquireDurationMs: duration,
      requestId,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    });
  }

  // Low-level stages (rls_tenant_context, rls_set_role, rls_setup_total, pool_acquire, pool_release,
  // and ordinary sub-threshold query executions) are internal diagnostics only output in DEBUG mode.
  if (logger.isDebugEnabled()) {
    logger.debug(`[DB Stage] ${stage} (${duration}ms)`, {
      type: "db_stage",
      stage,
      durationMs: duration,
      requestId,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      ...(details.sql ? { sql: details.sql.slice(0, 120) } : {}),
    });
  }
}

// ID validation — supports both standard UUIDs and legacy Integer IDs (numeric strings).
const ID_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

/**
 * Determines RLS configuration from the current ALS context.
 *
 * TWO-LAYER DESIGN:
 *
 *   Layer 1 — PostgreSQL Role (structural enforcement)
 *     • bypassRls: true  → RESET ROLE   (reverts to database owner/postgres which has BYPASSRLS)
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
 *   → RESET ROLE (database owner/postgres) + app.bypass_rls='on' → all rows visible.
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
      logger.warn(`Invalid companyId format "${raw}" — omitting from RLS context`);
    }
  }

  const candidateUserId = context?.userId == null ? '' : String(context.userId).trim();
  const userId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidateUserId)
    ? candidateUserId
    : '';

  return { bypassRls, role, companyId, userId };
}

/** Apply tenant context inside the active transaction so transaction poolers
 * pin one PostgreSQL backend for both RLS setup and the protected query. */
async function applyRlsToClient(client, context = storage.getStore()) {
  const { bypassRls, role, companyId, userId } = buildRlsConfig(context);
  const safeRole = String(role || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const setupStartedAt = performance.now();

  let stageStartedAt = performance.now();
  await client.query(
    `SELECT set_config('app.bypass_rls', $1, true),
            set_config('app.current_company_id', $2, true),
            set_config('app.current_role', $3, true),
            set_config('app.current_user_id', $4, true)`,
    [bypassRls ? 'on' : 'off', companyId, safeRole, userId]
  );
  recordDbStage('rls_tenant_context', performance.now() - stageStartedAt);
  if (!bypassRls) {
    // Failure must abort this transaction. Falling back to the database owner
    // could bypass RLS.
    stageStartedAt = performance.now();
    await client.query('SET LOCAL ROLE smarterp_app');
    recordDbStage('rls_set_role', performance.now() - stageStartedAt);
  }
  recordDbStage('rls_setup_total', performance.now() - setupStartedAt);
}

const CONTROL = /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b/i;

function getSql(text) {
  return typeof text === 'string' ? text.trim() : String(text?.text || '').trim();
}

/** Run each checked-out client query in an explicit transaction. Explicit
 * BEGIN/COMMIT calls from existing services remain supported; standalone
 * queries retain normal autocommit behavior. RLS state is transaction-local. */
function attachTransactionScopedRls(client, context) {
  const rawQuery = client.query.bind(client);
  const rawRelease = client.release.bind(client);
  let inTransaction = false;

  async function begin(beginSql = 'BEGIN') {
    const result = await rawQuery(beginSql);
    inTransaction = true;
    try {
      await applyRlsToClient({ query: rawQuery }, context);
      return result;
    } catch (error) {
      try { await rawQuery('ROLLBACK'); } catch (_) {}
      inTransaction = false;
      throw error;
    }
  }

  client.query = async function (text, values) {
    const sql = getSql(text);
    const control = sql.match(CONTROL)?.[1]?.split(/\s+/)[0]?.toUpperCase();

    if (control === 'BEGIN' || control === 'START') {
      if (inTransaction) return rawQuery(text, values);
      return begin(text);
    }
    if (control === 'COMMIT' || control === 'END') {
      if (!inTransaction) return rawQuery(text, values);
      try { return await rawQuery(text, values); }
      finally { inTransaction = false; }
    }
    if (control === 'ROLLBACK' || control === 'ABORT') {
      if (!inTransaction) return rawQuery(text, values);
      try { return await rawQuery(text, values); }
      finally { inTransaction = false; }
    }

    const ownsTransaction = !inTransaction;
    if (ownsTransaction) await begin();
    try {
      const result = await rawQuery(text, values);
      if (ownsTransaction) {
        await rawQuery('COMMIT');
        inTransaction = false;
      }
      return result;
    } catch (error) {
      if (ownsTransaction && inTransaction) {
        try { await rawQuery('ROLLBACK'); } catch (_) {}
        inTransaction = false;
      }
      throw error;
    }
  };

  client.release = function (error) {
    if (!inTransaction) return rawRelease(error);
    inTransaction = false;
    rawQuery('ROLLBACK').then(
      () => rawRelease(error),
      () => rawRelease(error || new Error('Failed to rollback database transaction before release'))
    );
  };
  return client;
}

// ─── Patch pool.connect ───────────────────────────────────────────────────────
const originalConnect = pool.connect.bind(pool);

pool.connect = async function () {
  const acquireStartedAt = performance.now();
  const client = await originalConnect();
  recordDbStage('pool_acquire', performance.now() - acquireStartedAt);
  return attachTransactionScopedRls(client, storage.getStore());
};

// ─── Patch pool.query ─────────────────────────────────────────────────────────
// Convenience wrapper uses the same explicit transaction and transaction-local
// RLS setup as clients checked out directly.
pool.query = async function (text, params) {
  const client = await pool.connect(); // uses the patched version above
  const queryStartedAt = performance.now();
  const sql = getSql(text);
  try {
    return await client.query(text, params);
  } catch (err) {
    const context = storage.getStore();
    logger.error(`Database query failed: ${sql.slice(0, 120)}`, err, {
      requestId: context?.requestId || null,
      operation: sql.slice(0, 120),
    });
    throw err;
  } finally {
    const durationMs = performance.now() - queryStartedAt;
    recordDbStage('sql_execution', durationMs, { sql });
    const releaseStartedAt = performance.now();
    client.release();
    recordDbStage('pool_release', performance.now() - releaseStartedAt);
  }
};

module.exports = { pool, buildRlsConfig, applyRlsToClient, attachTransactionScopedRls };
