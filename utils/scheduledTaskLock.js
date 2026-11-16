'use strict';

const { pool: defaultPool } = require('../db');
const defaultLogger = require('./logger');

function createScheduledTaskLock({
  pool = defaultPool,
  logger = defaultLogger,
  onOwnershipLost = () => process.exit(1),
} = {}) {
  // Per-process serialization ensures the lock connection never consumes both
  // sessions in the deliberately small PostgreSQL pool.
  let localQueue = Promise.resolve();
  const queuedOrRunning = new Set();

  async function runWithPostgresAdvisoryLock(taskName, callback) {
    const key = `smarterp-scheduled:${taskName}`;
    if (queuedOrRunning.has(key)) return { acquired: false, reason: 'already_queued_or_running' };
    queuedOrRunning.add(key);

    const run = async () => {
    let client;
    let acquired = false;
    let ownershipLost = false;
    const onError = (error) => {
      if (!acquired || ownershipLost) return;
      ownershipLost = true;
      try { logger.error('Scheduled task lock connection was lost; terminating owner worker', { taskName, error: error?.message }); } catch {}
      // A session advisory lock is released by PostgreSQL when its connection
      // dies. Terminating this process prevents the former owner continuing work.
      try { onOwnershipLost(error); } catch { try { process.exit(1); } catch {} }
    };

    try {
      client = await pool.connect();
      client.on?.('error', onError);
      const lockResult = await client.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [key],
      );
      acquired = lockResult.rows?.[0]?.acquired === true;
      if (!acquired) return { acquired: false, reason: 'owned_by_another_instance' };
      const result = await callback();
      return { acquired: true, result };
    } catch (error) {
      try { logger.warn('Scheduled task did not run because lock/database access failed', { taskName, error: error?.message }); } catch {}
      return { acquired: false, reason: 'lock_or_task_failed', error };
    } finally {
      if (client) {
        if (acquired && !ownershipLost) {
          try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]); }
          catch { /* connection loss releases session lock automatically */ }
        }
        client.removeListener?.('error', onError);
        try { client.release(); } catch { /* release failures must not escape the scheduler */ }
      }
    }
    };

    const queued = localQueue.then(run, run);
    localQueue = queued.then(() => undefined, () => undefined);
    try { return await queued; }
    finally { queuedOrRunning.delete(key); }
  }

  return { runWithPostgresAdvisoryLock, drain: () => localQueue };
}

const defaultLockRunner = createScheduledTaskLock();

module.exports = {
  createScheduledTaskLock,
  runWithPostgresAdvisoryLock: defaultLockRunner.runWithPostgresAdvisoryLock,
  drainScheduledTaskLocks: defaultLockRunner.drain,
};
