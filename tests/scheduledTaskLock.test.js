'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createScheduledTaskLock } = require('../utils/scheduledTaskLock');

function sharedFakeDatabase() {
  const held = new Set();
  return {
    held,
    pool: {
      async connect() {
        const client = new EventEmitter();
        let ownLock;
        client.query = async (sql, params) => {
          if (sql.includes('pg_try_advisory_lock')) {
            const key = params[0];
            if (held.has(key)) return { rows: [{ acquired: false }] };
            held.add(key);
            ownLock = key;
            return { rows: [{ acquired: true }] };
          }
          if (sql.includes('pg_advisory_unlock')) {
            held.delete(params[0]);
            ownLock = null;
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          throw new Error('unexpected test query');
        };
        client.release = () => { if (ownLock) held.delete(ownLock); };
        return client;
      },
    },
  };
}

test('two independent instance coordinators cannot run the same scheduled task concurrently', async () => {
  const database = sharedFakeDatabase();
  const first = createScheduledTaskLock({ pool: database.pool, logger: { warn() {}, error() {} } });
  const second = createScheduledTaskLock({ pool: database.pool, logger: { warn() {}, error() {} } });
  let releaseFirst;
  const firstWork = first.runWithPostgresAdvisoryLock('attendance', () => new Promise((resolve) => { releaseFirst = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  let secondRuns = 0;
  const secondResult = await second.runWithPostgresAdvisoryLock('attendance', async () => { secondRuns += 1; });
  assert.deepEqual(secondResult, { acquired: false, reason: 'owned_by_another_instance' });
  assert.equal(secondRuns, 0);
  releaseFirst('done');
  assert.equal((await firstWork).acquired, true);
  assert.equal(database.held.size, 0);
});

test('different scheduled task names acquire independent locks', async () => {
  const database = sharedFakeDatabase();
  const first = createScheduledTaskLock({ pool: database.pool, logger: { warn() {}, error() {} } });
  const second = createScheduledTaskLock({ pool: database.pool, logger: { warn() {}, error() {} } });
  let releaseFirst;
  const firstWork = first.runWithPostgresAdvisoryLock('attendance', () => new Promise((resolve) => { releaseFirst = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const secondResult = await second.runWithPostgresAdvisoryLock('subscriptions', async () => 'ok');
  assert.equal(secondResult.acquired, true);
  assert.equal(secondResult.result, 'ok');
  releaseFirst();
  await firstWork;
});

test('database lock errors fail closed without invoking scheduled work', async () => {
  const lock = createScheduledTaskLock({
    pool: { async connect() { return { query: async () => { throw new Error('database unavailable'); }, release() {} }; } },
    logger: { warn() {}, error() {} },
  });
  let ran = false;
  const result = await lock.runWithPostgresAdvisoryLock('subscription-lifecycle', async () => { ran = true; });
  assert.equal(result.acquired, false);
  assert.equal(result.reason, 'lock_or_task_failed');
  assert.equal(ran, false);
});

test('session loss signals the owner worker to terminate instead of continuing stale work', async () => {
  let client;
  let ownershipLosses = 0;
  const lock = createScheduledTaskLock({
    pool: { async connect() {
      client = new EventEmitter();
      client.query = async (sql) => sql.includes('pg_try_advisory_lock')
        ? { rows: [{ acquired: true }] }
        : { rows: [{ pg_advisory_unlock: true }] };
      client.release = () => {};
      return client;
    } },
    logger: { warn() {}, error() {} },
    onOwnershipLost() { ownershipLosses += 1; },
  });
  let releaseWork;
  const active = lock.runWithPostgresAdvisoryLock('geofence', () => new Promise((resolve) => { releaseWork = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  client.emit('error', new Error('connection lost'));
  assert.equal(ownershipLosses, 1);
  releaseWork();
  await active;
});
