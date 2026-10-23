'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deliverUserEvent, notificationRecipientIdempotencyKey } = require('../utils/notificationDelivery');

test('Redis-backed notification delivery uses only Redis, avoiding local plus pub/sub duplicates', async () => {
  const calls = [];
  const redisClient = {
    status: 'ready',
    publish: async (...args) => calls.push(['redis', ...args]),
  };
  const result = deliverUserEvent({
    userId: 'owner-1',
    message: { type: 'notification', data: { id: 17 } },
    redisClient,
    localBroadcast: (...args) => calls.push(['local', ...args]),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result, 'redis');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'redis');
  assert.equal(calls[0][1], 'employee_notifications:owner-1');
});

test('notification delivery falls back to in-process SSE when Redis is unavailable', () => {
  const calls = [];
  const result = deliverUserEvent({
    userId: 'owner-1',
    message: { type: 'notification', data: { id: 17 } },
    redisClient: { status: 'end', publish() { throw new Error('must not publish'); } },
    localBroadcast: (...args) => calls.push(args),
  });
  assert.equal(result, 'local');
  assert.deepEqual(calls, [['owner-1', { type: 'notification', data: { id: 17 } }]]);
});

test('logical event idempotency is stable per recipient and distinct across recipients/events', () => {
  const first = notificationRecipientIdempotencyKey('proof:co-1:proof-9', 'owner-1');
  assert.equal(first, notificationRecipientIdempotencyKey('proof:co-1:proof-9', 'owner-1'));
  assert.notEqual(first, notificationRecipientIdempotencyKey('proof:co-1:proof-9', 'owner-2'));
  assert.notEqual(first, notificationRecipientIdempotencyKey('proof:co-1:proof-10', 'owner-1'));
  assert.equal(notificationRecipientIdempotencyKey('', 'owner-1'), null);
});

test('site-proof notification is keyed by the persisted proof event, never its message text', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/proofOfWork.js'), 'utf8');
  assert.match(source, /idempotency_key: `proof_of_work:\$\{effectiveCompanyId\}:\$\{savedProof\.id\}`/);
  assert.match(source, /if \(!inserted\) \{\s*return res\.status\(200\)/);
});

test('bulk recipient notification writes use a recipient-specific stable key and database conflict handling', () => {
  const source = fs.readFileSync(path.join(__dirname, '../utils/notificationHelpers.js'), 'utf8');
  assert.match(source, /notificationRecipientIdempotencyKey\(idempotency_key, owner\.id\)/);
  assert.match(source, /notificationRecipientIdempotencyKey\(idempotency_key, emp\.id\)/);
  assert.equal((source.match(/ON CONFLICT \(idempotency_key\) WHERE idempotency_key IS NOT NULL DO NOTHING/g) || []).length, 3);
});
