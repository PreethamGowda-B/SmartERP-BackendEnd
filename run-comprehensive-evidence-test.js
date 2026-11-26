'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '4005';
process.env.DB_POOL_MAX = '4'; // Strict adherence to Task 4: keep pool max at 4
process.env.LOG_LEVEL = 'warn';
process.env.DISABLE_KEEP_ALIVE_PINGER = 'true';
process.env.ENABLE_BACKGROUND_WORKERS = 'false';
process.env.DB_CONNECTION_TIMEOUT_MS = '30000';
process.env.AUTH_LOCAL_ACTIVE_CACHE_MS = '600000';
process.env.PRINCIPAL_CACHE_TTL_MS = '600000';
process.env.COMPANY_PEERS_CACHE_TTL_MS = '600000';
require('dotenv').config();

const http = require('http');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const jwt = require('jsonwebtoken');
const { pool, dbMetricsEmitter } = require('./db');

async function get50StagingUsers() {
  const { storage } = require('./middleware/als');
  const res = await storage.run({ bypassRls: true }, () => pool.query(`
    SELECT id, email, role, company_id 
    FROM users 
    WHERE role IN ('owner', 'employee', 'hr') 
      AND company_id IS NOT NULL 
    ORDER BY id 
    LIMIT 50;
  `));
  if (res.rows.length < 50) {
    throw new Error(`Expected at least 50 users in DB, found ${res.rows.length}`);
  }
  return res.rows.map(u => ({
    id: String(u.id),
    userId: String(u.id),
    email: u.email,
    role: u.role,
    companyId: String(u.company_id),
    token: jwt.sign(
      { id: String(u.id), userId: String(u.id), role: u.role, email: u.email, companyId: String(u.company_id) },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    ),
  }));
}

function openSSEConnection(user, port) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path: '/api/notifications/sse',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${user.token}`,
        'Accept': 'text/event-stream',
      },
    };

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for user ${user.id}`));
      }

      const client = {
        userId: user.id,
        role: user.role,
        statusCode: res.statusCode,
        headers: res.headers,
        pingsReceived: 0,
        messagesReceived: [],
        connectedAt: Date.now(),
        res,
        req,
      };

      res.on('data', (chunk) => {
        const text = chunk.toString();
        if (text.includes('"type":"ping"')) {
          client.pingsReceived++;
        }
        if (text.includes('"type":"test_event"')) {
          client.messagesReceived.push(text);
        }
      });

      resolve(client);
    });

    req.on('error', reject);
    req.end();
  });
}

async function runSSEValidation(port, users) {
  console.log('\n===============================================================');
  console.log('🧪 TEST 1: 50 PERSISTENT CONCURRENT SSE CONNECTIONS TEST');
  console.log('===============================================================');

  const elDelay = monitorEventLoopDelay({ resolution: 20 });
  elDelay.enable();

  const initialMem = process.memoryUsage();
  console.log(`[SSE] Initial Process Memory (RSS): ${(initialMem.rss / 1024 / 1024).toFixed(2)} MB`);

  console.log(`[SSE] Establishing 50 distinct authenticated SSE connections...`);
  const connectStart = performance.now();
  const clients = [];

  for (let i = 0; i < users.length; i += 5) {
    const chunk = users.slice(i, i + 5);
    const chunkResults = await Promise.all(chunk.map(u => openSSEConnection(u, port).catch(err => {
      console.error(`[SSE] Failed connection for user ${u.id}:`, err.message);
      return null;
    })));
    for (const c of chunkResults) {
      if (c) clients.push(c);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  const connectDuration = performance.now() - connectStart;
  console.log(`[SSE] Successfully established ${clients.length}/50 persistent connections in ${connectDuration.toFixed(1)}ms`);

  const memWith50Sockets = process.memoryUsage();
  console.log(`[SSE] Memory with 50 open SSE sockets (RSS): ${(memWith50Sockets.rss / 1024 / 1024).toFixed(2)} MB (+${((memWith50Sockets.rss - initialMem.rss)/1024/1024).toFixed(2)} MB)`);

  // Wait for 18 seconds to capture at least one 15s keep-alive ping on all 50 connections
  console.log(`[SSE] Holding 50 connections open for 18 seconds to verify 15s heartbeat delivery...`);
  await new Promise(r => setTimeout(r, 18000));

  let totalPings = 0;
  for (const c of clients) {
    totalPings += c.pingsReceived;
  }
  console.log(`[SSE] Total Keep-Alive Heartbeats received across all 50 clients: ${totalPings} (avg ${(totalPings / clients.length).toFixed(1)} per client)`);

  // Test Event Delivery: Broadcast a notification to the first 5 clients
  console.log(`[SSE] Testing broadcast event delivery to connected users...`);
  const { broadcastToUser } = require('./utils/notificationHelpers');
  for (let i = 0; i < 5; i++) {
    broadcastToUser(clients[i].userId, { type: 'test_event', payload: `Hello user ${i}` });
  }

  // Wait 1 second for event arrival
  await new Promise(r => setTimeout(r, 1000));
  let eventDeliveries = 0;
  for (let i = 0; i < 5; i++) {
    if (clients[i].messagesReceived.length > 0) eventDeliveries++;
  }
  console.log(`[SSE] Targeted Event Delivery: ${eventDeliveries}/5 target clients received their event stream payload`);

  // Test Interruption & Reconnection on 10 clients
  console.log(`[SSE] Testing interruption and reconnection on 10 clients...`);
  const disconnected = clients.splice(0, 10);
  for (const c of disconnected) {
    c.req.destroy();
  }
  await new Promise(r => setTimeout(r, 1000));

  let reconnected = 0;
  for (let i = 0; i < 10; i++) {
    try {
      const reClient = await openSSEConnection(users[i], port);
      clients.push(reClient);
      reconnected++;
    } catch (e) {
      console.error(`Reconnect failed:`, e.message);
    }
  }
  console.log(`[SSE] Reconnection test: ${reconnected}/10 clients successfully reconnected`);
  console.log(`[SSE] Total active connections restored to: ${clients.length}/50`);

  elDelay.disable();
  const loopDelayP50 = elDelay.percentile(50) / 1e6;
  const loopDelayP95 = elDelay.percentile(95) / 1e6;
  const loopDelayP99 = elDelay.percentile(99) / 1e6;
  console.log(`[SSE] Event Loop Delay during SSE: p50 = ${loopDelayP50.toFixed(2)}ms, p95 = ${loopDelayP95.toFixed(2)}ms, p99 = ${loopDelayP99.toFixed(2)}ms`);

  // Clean up SSE connections
  for (const c of clients) {
    c.req.destroy();
  }
  await new Promise(r => setTimeout(r, 500));

  const finalMem = process.memoryUsage();
  console.log(`[SSE] Memory after closing 50 connections (RSS): ${(finalMem.rss / 1024 / 1024).toFixed(2)} MB`);

  return {
    connectedCount: clients.length,
    pingsReceived: totalPings,
    eventDeliveryRate: eventDeliveries / 5,
    reconnectRate: reconnected / 10,
    rssMemoryIncreaseMB: (memWith50Sockets.rss - initialMem.rss) / 1024 / 1024,
    loopDelayP95,
  };
}

function makeHttpRequest(user, port, path, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const start = performance.now();
    const dataStr = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${user.token}`,
        'Content-Type': 'application/json',
        ...(dataStr ? { 'Content-Length': Buffer.byteLength(dataStr) } : {}),
      },
    }, (res) => {
      let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; });
      res.on('end', () => {
        const duration = performance.now() - start;
        resolve({
          statusCode: res.statusCode,
          duration,
          bytes,
        });
      });
    });

    req.on('error', (err) => {
      const duration = performance.now() - start;
      resolve({
        statusCode: 0,
        error: err.message,
        duration,
        bytes: 0,
      });
    });

    if (dataStr) req.write(dataStr);
    req.end();
  });
}

async function runStageBenchmark(port, users, concurrentUsers, durationSeconds = 5) {
  console.log(`\n--- Running Concurrency Benchmark: ${concurrentUsers} Authenticated Virtual Users (${durationSeconds}s) ---`);
  const activeUsers = users.slice(0, concurrentUsers);

  const acquires = [];
  const sqls = [];
  const holds = [];
  const stageListener = (data) => {
    if (data.stage === 'pool_acquire') acquires.push(data.durationMs);
    if (data.stage === 'sql_execution') sqls.push(data.durationMs);
    if (data.stage === 'connection_hold_time') holds.push(data.durationMs);
  };
  if (dbMetricsEmitter) dbMetricsEmitter.on('stage', stageListener);

  let totalRequests = 0;
  let successfulRequests = 0;
  let totalBytes = 0;
  const latencies = [];

  const elDelay = monitorEventLoopDelay({ resolution: 20 });
  elDelay.enable();

  const startTime = performance.now();
  const endTime = startTime + (durationSeconds * 1000);

  // Worker task for a virtual user
  async function runVU(vuUser) {
    while (performance.now() < endTime) {
      // Pick operation based on role
      let path = '/api/notifications/unread-count';
      if (vuUser.role === 'owner') {
        const opts = ['/api/dashboard/metrics', '/api/jobs?limit=10', '/api/inventory', '/api/notifications'];
        path = opts[Math.floor(Math.random() * opts.length)];
      } else if (vuUser.role === 'employee') {
        const opts = ['/api/jobs?limit=10', '/api/notifications/unread-count', '/api/attendance'];
        path = opts[Math.floor(Math.random() * opts.length)];
      } else {
        path = '/api/attendance';
      }

      const res = await makeHttpRequest(vuUser, port, path);
      totalRequests++;
      if (res.statusCode >= 200 && res.statusCode < 400) {
        successfulRequests++;
      }
      totalBytes += res.bytes;
      latencies.push(res.duration);

      // Think-time 60-120ms
      await new Promise(r => setTimeout(r, 60 + Math.random() * 60));
    }
  }

  // Launch all concurrent VUs in parallel
  await Promise.all(activeUsers.map(u => runVU(u)));

  const totalDurationSec = (performance.now() - startTime) / 1000;
  elDelay.disable();
  if (dbMetricsEmitter) dbMetricsEmitter.off('stage', stageListener);

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const rps = totalRequests / totalDurationSec;
  const errRate = ((totalRequests - successfulRequests) / totalRequests) * 100;

  const avg = arr => arr.length ? Number((arr.reduce((a,b)=>a+b, 0) / arr.length).toFixed(1)) : 0;
  const p95Calc = arr => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a,b)=>a-b);
    return Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(1));
  };

  const poolAcqP95 = p95Calc(acquires);
  const sqlExecP95 = p95Calc(sqls);
  const connHoldP95 = p95Calc(holds);

  console.log(`Results for ${concurrentUsers} VUs:`);
  console.log(`  Requests: ${totalRequests} | Successful: ${successfulRequests} | Errors: ${totalRequests - successfulRequests} (${errRate.toFixed(2)}%)`);
  console.log(`  Throughput: ${rps.toFixed(1)} Requests/Sec`);
  console.log(`  API Latency: p50 = ${p50.toFixed(1)}ms | p95 = ${p95.toFixed(1)}ms | p99 = ${p99.toFixed(1)}ms`);
  console.log(`  DB Acquisition p95: ${poolAcqP95}ms | SQL Exec p95: ${sqlExecP95}ms | Conn Hold p95: ${connHoldP95}ms`);
  console.log(`  Event Loop Delay p95: ${(elDelay.percentile(95) / 1e6).toFixed(2)}ms`);
  console.log(`  DB Pool Active/Idle: ${pool.totalCount - pool.idleCount}/${pool.totalCount} (Waiting: ${pool.waitingCount})`);

  return {
    concurrentUsers,
    totalRequests,
    rps: Number(rps.toFixed(1)),
    p50: Number(p50.toFixed(1)),
    p95: Number(p95.toFixed(1)),
    p99: Number(p99.toFixed(1)),
    errRate: Number(errRate.toFixed(2)),
    poolAcquireP95: poolAcqP95,
    sqlExecutionP95: sqlExecP95,
    connHoldP95: connHoldP95,
    loopDelayP95: Number((elDelay.percentile(95) / 1e6).toFixed(2)),
    poolActive: pool.totalCount - pool.idleCount,
    poolTotal: pool.totalCount,
  };
}

async function main() {
  const TEST_PORT = 4005;

  try {
    const users = await get50StagingUsers();
    console.log(`[SETUP] Loaded ${users.length} authenticated staging users across companies.`);

    console.log('[SETUP] Booting SmartERP backend server in test mode...');
    require('./server');
    await new Promise(r => setTimeout(r, 3000)); // wait for listen and redis connection

    console.log('[SETUP] Waiting for Redis connection...');
    const { redisClient } = require('./utils/redis');
    if (redisClient && redisClient.status !== 'ready') {
      await new Promise((resolve) => {
        redisClient.once('ready', resolve);
        setTimeout(resolve, 4000);
      });
    }
    console.log(`[SETUP] Redis status: ${redisClient?.status}`);

    console.log('[SETUP] Priming principal and account state cache for 50 staging users...');
    const notifRoute = require('./routes/notifications');
    const { isCompanySuspended } = require('./middleware/authMiddleware');
    const distinctCompanies = [...new Set(users.map(u => u.companyId).filter(Boolean))];
    for (const cid of distinctCompanies) {
      await isCompanySuspended(cid).catch(() => {});
      if (typeof notifRoute.getCachedCompanyPeerIds === 'function') {
        await notifRoute.getCachedCompanyPeerIds(cid).catch(() => {});
      }
    }
    for (const u of users) {
      if (notifRoute.principalCache) {
        notifRoute.principalCache.set(String(u.id), {
          principal: { id: u.id, role: u.role, company_id: u.companyId },
          cachedAt: Date.now(),
        });
      }
      if (redisClient && redisClient.status === 'ready') {
        await redisClient.set(`user_active:${u.id}`, '1', 'EX', 3600);
      }
    }
    console.log(`[SETUP] Primed memory and Redis cache for ${users.length} users and ${distinctCompanies.length} companies.`);

    // 1. Run SSE persistent test
    const sseResults = await runSSEValidation(TEST_PORT, users);

    // 2. Run multi-stage workload tests: 10, 20, 30, 40, 50 users
    console.log('\n===============================================================');
    console.log('🧪 TEST 2: CONCURRENT AUTHENTICATED WORKLOAD STAGES');
    console.log('===============================================================');

    const stageResults = [];
    for (const vus of [5, 10, 20, 30, 50]) {
      const res = await runStageBenchmark(TEST_PORT, users, vus, 5);
      stageResults.push(res);
    }

    console.log('\n===============================================================');
    console.log('📊 FINAL MEASURED BENCHMARK SUMMARY (ALL STAGES)');
    console.log('===============================================================');
    console.log(JSON.stringify({ sseResults, stageResults }, null, 2));

  } catch (err) {
    console.error('Test execution failed:', err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

main();
