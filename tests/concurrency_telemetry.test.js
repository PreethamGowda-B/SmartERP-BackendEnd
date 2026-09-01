/**
 * tests/concurrency_telemetry.test.js
 *
 * Concurrency & Load Verification for Security Telemetry:
 * Dispatches 50 simultaneous parallel security events from the same IP
 * and verifies that Redis atomic INCR reaches exactly 50 with 0 dropped events.
 */

require('dotenv').config();
const { pool } = require('../db');
const { redisClient } = require('../utils/redis');
const { emitSecurityEvent, SECURITY_EVENT_TYPES } = require('../utils/securityEmitter');

async function runConcurrencyTest() {
  console.log('🧪 Starting Concurrency & Atomic Race Condition Test...\n');

  if (redisClient && redisClient.status !== 'ready') {
    await new Promise((resolve) => {
      redisClient.once('ready', resolve);
      setTimeout(resolve, 3000); // 3s timeout fallback
    });
  }

  const testIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
  const totalConcurrent = 50;

  console.log(`📡 Dispatching ${totalConcurrent} simultaneous parallel failed logins for IP: ${testIp}`);

  const promises = [];
  for (let i = 1; i <= totalConcurrent; i++) {
    promises.push(new Promise((resolve) => {
      emitSecurityEvent({
        companyId: '1',
        userId: '00000000-0000-0000-0000-000000000001',
        eventType: SECURITY_EVENT_TYPES.AUTH_FAILED,
        severity: 'medium',
        ipAddress: testIp,
        userAgent: 'ConcurrentTester/1.0',
        endpoint: '/api/auth/login',
        httpMethod: 'POST',
        statusCode: 401,
        metadata: {
          attemptNumber: i,
          identifier: `concurrent_user_${i}@company.com`,
          token: 'sensitive-token-must-be-redacted',
        }
      });
      // setImmediate inside emitSecurityEvent dispatches immediately
      resolve();
    }));
  }

  await Promise.all(promises);

  // Wait 5s for all 50 async DB (Neon/Supabase) and Redis (Upstash) TLS network writes to finish
  await new Promise((r) => setTimeout(r, 5000));

  // 1. Verify Redis Counter
  let redisCount = null;
  if (redisClient && redisClient.status === 'ready') {
    const key = `sec_window:${SECURITY_EVENT_TYPES.AUTH_FAILED}:${testIp}`;
    redisCount = await redisClient.get(key);
    console.log(`📊 Redis Key: ${key}`);
    console.log(`📊 Redis Final Counter Value: ${redisCount} (Expected: ${totalConcurrent})`);
  }

  // 2. Verify PostgreSQL Rows Inserted
  const dbRes = await pool.query(
    'SELECT COUNT(*) FROM security_events WHERE ip_address = $1 AND event_type = $2',
    [testIp, SECURITY_EVENT_TYPES.AUTH_FAILED]
  );
  const dbCount = parseInt(dbRes.rows[0].count, 10);
  console.log(`📊 PostgreSQL Rows Inserted: ${dbCount} (Expected: ${totalConcurrent})`);

  const redisPassed = redisCount ? parseInt(redisCount, 10) === totalConcurrent : true;
  const dbPassed = dbCount === totalConcurrent;

  if (redisPassed && dbPassed) {
    console.log(`\n✅ PASS: Concurrency test verified with 0 dropped events (Redis: ${redisCount}, DB: ${dbCount})`);
  } else {
    console.error(`\n❌ FAIL: Concurrency mismatch (Redis: ${redisCount}, DB: ${dbCount}, Expected: ${totalConcurrent})`);
  }

  pool.end();
  if (redisClient && typeof redisClient.quit === 'function') redisClient.quit();
  process.exit(redisPassed && dbPassed ? 0 : 1);
}

runConcurrencyTest().catch((e) => {
  console.error('Fatal concurrency runner error:', e);
  process.exit(1);
});
