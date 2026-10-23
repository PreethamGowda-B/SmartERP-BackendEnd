'use strict';

const ACCOUNT_STATE_LOCK_PREFIX = 'security-user-state:';

function accountStateLockKey(userId) {
  return `${ACCOUNT_STATE_LOCK_PREFIX}${String(userId)}`;
}

async function reactivateStaffAccount({ pool, redisClient, userId, actorId, reason, now = Date.now() }) {
  const targetId = String(userId || '').toLowerCase();
  const actingId = String(actorId || '');
  const note = typeof reason === 'string' ? reason.trim() : '';
  if (!targetId || !actingId) return { ok: false, status: 400, code: 'ACCOUNT_ID_REQUIRED' };
  if (targetId.toLowerCase() === actingId.toLowerCase()) return { ok: false, status: 409, code: 'SELF_REACTIVATION_FORBIDDEN' };
  if (note.length < 8 || note.length > 500) return { ok: false, status: 400, code: 'REASON_REQUIRED' };
  if (!redisClient || redisClient.status !== 'ready') {
    return { ok: false, status: 503, code: 'SESSION_STORE_UNAVAILABLE' };
  }

  const client = await pool.connect();
  let transactionStarted = false;
  let updatedAccount;
  let changed = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [accountStateLockKey(targetId)]);

    const account = await client.query(
      `SELECT id::text, name, email, role, is_active, company_id::text,
              COALESCE(NULLIF(to_jsonb(u)->>'status', ''), 'active') AS account_status
       FROM users u WHERE id::text = $1 FOR UPDATE`,
      [targetId]
    );
    if (!account.rows.length) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return { ok: false, status: 404, code: 'ACCOUNT_NOT_FOUND' };
    }
    const current = account.rows[0];
    // Revoke credentials before enabling the DB account. If a later DB step
    // fails, the only side effect is a safe forced re-login.
    try {
      await redisClient.set(`token_revoked:${targetId}`, String(now), 'EX', 86400);
    } catch (_) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return { ok: false, status: 503, code: 'SESSION_STORE_UNAVAILABLE' };
    }

    const statusColumn = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'status'
       ) AS present`
    );
    if (statusColumn.rows[0]?.present) {
      const result = await client.query(
        `UPDATE users SET is_active = TRUE, status = 'active' WHERE id::text = $1
         RETURNING id::text, name, email, role, is_active, company_id::text,
                   'active'::text AS account_status`,
        [targetId]
      );
      updatedAccount = result.rows[0];
    } else {
      const result = await client.query(
        `UPDATE users SET is_active = TRUE WHERE id::text = $1
         RETURNING id::text, name, email, role, is_active, company_id::text, 'active'::text AS account_status`,
        [targetId]
      );
      updatedAccount = result.rows[0];
    }
    changed = current.is_active !== true || ['suspended', 'inactive'].includes(String(current.account_status).toLowerCase());

    // Pending/approved proposals are cancelled; executed account suspensions
    // are marked reverted. Preserve each original action and its incident.
    const actions = await client.query(
      `SELECT id, approval_status, details FROM security_actions
       WHERE action_type = 'USER_SUSPEND'
         AND details->>'userId' = $1
         AND approval_status IN ('pending', 'approved', 'executed')
       FOR UPDATE`,
      [targetId]
    );
    const actionIds = [];
    for (const action of actions.rows) {
      const details = action.details && typeof action.details === 'object' ? action.details : {};
      const wasExecuted = details.executionDetails?.suspendedUserId === targetId;
      const nextStatus = wasExecuted ? 'reverted' : 'cancelled';
      const resolution = { reactivatedAt: new Date(now).toISOString(), reactivatedBy: actingId, reason: note };
      await client.query(
        `UPDATE security_actions
         SET approval_status = $1,
             executed_by = $2,
             reverted_at = CASE WHEN $1 = 'reverted' THEN NOW() ELSE reverted_at END,
             details = jsonb_set(COALESCE(details, '{}'::jsonb), '{reactivation}', $3::jsonb, true)
         WHERE id = $4`,
        [nextStatus, actingId, JSON.stringify(resolution), action.id]
      );
      actionIds.push(String(action.id));
    }

    await client.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1::uuid AND revoked = FALSE`,
      [targetId]
    );
    await client.query(
      `INSERT INTO activities (user_id, action, activity_type, details, ip_address, user_agent, created_at)
       VALUES ($1::uuid, 'account_reactivated', 'account_security', $2::jsonb, NULL, NULL, NOW())`,
      [actingId, JSON.stringify({ target_user_id: targetId, reason: note, resolution: 'reactivated', security_action_ids: actionIds })]
    );

    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '23503' || error?.code === '22P02') return { ok: false, status: 400, code: 'ACCOUNT_ID_INVALID' };
    throw error;
  } finally {
    client.release();
  }

  // Keep the revocation timestamp: old access tokens and refresh tokens stay
  // revoked. Only clear the account block after the DB commit; fresh login is
  // required to receive credentials newer than the revocation timestamp.
  try {
    await redisClient.del(`user_suspended:${targetId}`);
    await redisClient.set(`user_active:${targetId}`, '1', 'EX', 60);
  } catch (_) {
    return { ok: false, status: 503, code: 'ACCOUNT_REACTIVATED_CACHE_REFRESH_REQUIRED', account: updatedAccount, changed };
  }

  return { ok: true, account: updatedAccount, changed };
}

module.exports = { ACCOUNT_STATE_LOCK_PREFIX, accountStateLockKey, reactivateStaffAccount };
