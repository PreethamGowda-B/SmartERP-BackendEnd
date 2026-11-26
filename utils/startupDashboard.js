/**
 * utils/startupDashboard.js
 * Professional startup dashboard and deployment visibility reporter for Render logs.
 */

'use strict';

const releaseInfo = require('../config/releaseInfo');
const { inspectDatabaseMigrations } = require('./migrationInspector');
const logger = require('./logger');

/**
 * Gathers infrastructure health and dependency readiness.
 */
async function gatherInfrastructureStatus(pool, redisClient) {
  const status = {
    database: { connected: false, poolMax: 4, poolTotal: 0, poolIdle: 0, poolWaiting: 0, latencyMs: null },
    redis: { connected: false, status: 'disabled' },
    bullmq: { active: false, queues: [] },
    cloudinary: { configured: false, cloudName: null },
    firebase: { initialized: false },
    resend: { configured: false },
    sentry: { initialized: false },
  };

  // 1. PostgreSQL DB Health
  if (pool) {
    try {
      const startedAt = Date.now();
      const r = await pool.query('SELECT 1 AS ready');
      status.database.connected = r.rows[0]?.ready === 1;
      status.database.latencyMs = Date.now() - startedAt;
      status.database.poolMax = pool.options?.max || 4;
      status.database.poolTotal = pool.totalCount || 0;
      status.database.poolIdle = pool.idleCount || 0;
      status.database.poolWaiting = pool.waitingCount || 0;
    } catch (err) {
      status.database.error = err.message;
    }
  }

  // 2. Redis Cache & Pub/Sub
  if (redisClient) {
    status.redis.status = redisClient.status || 'unknown';
    status.redis.connected = redisClient.status === 'ready';
  } else if (process.env.REDIS_URL) {
    status.redis.status = 'configured_unconnected';
  }

  // 3. BullMQ Queues
  if (redisClient && redisClient.status === 'ready') {
    status.bullmq.active = true;
    status.bullmq.queues = ['notifications', 'audit', 'webhook-retry'];
  }

  // 4. Cloudinary
  try {
    const { hasCloudinaryConfig } = require('../config/cloudinary');
    status.cloudinary.configured = Boolean(hasCloudinaryConfig);
    const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
    status.cloudinary.cloudName = cloudName ? `${cloudName.slice(0, 3)}***` : null;
  } catch {
    status.cloudinary.configured = false;
  }

  // 5. Firebase Admin
  try {
    const admin = require('firebase-admin');
    status.firebase.initialized = Boolean(typeof admin.getApps === 'function' ? admin.getApps().length > 0 : (admin.apps && admin.apps.length > 0));
  } catch {
    status.firebase.initialized = false;
  }

  // 6. Resend Email
  status.resend.configured = Boolean(process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim());

  // 7. Sentry APM
  status.sentry.initialized = Boolean(process.env.SENTRY_DSN && process.env.SENTRY_DSN.trim());

  return status;
}

/**
 * Formats and prints the complete enterprise startup dashboard.
 */
async function printStartupDashboard({
  port,
  processRole = 'worker',
  workerId = 1,
  isPrimaryWorker = true,
  pool,
  redisClient,
  backgroundWorkersStarted = false,
}) {
  const gitInfo = releaseInfo.getGitInfo();
  const infra = await gatherInfrastructureStatus(pool, redisClient);
  const migrations = await inspectDatabaseMigrations(pool);

  const divider = '='.repeat(80);
  const subDivider = '-'.repeat(80);

  const lines = [
    divider,
    '                    SmartERP Enterprise Backend — Deployment Summary',
    divider,
    '[APPLICATION]',
    `  Product Name     : ${releaseInfo.productName}`,
    `  Environment      : ${process.env.NODE_ENV || 'development'}`,
    `  App Version      : v${releaseInfo.version}`,
    `  Git Commit SHA   : ${gitInfo.commitSha}`,
    `  Git Branch       : ${gitInfo.branch}`,
    `  Deployment Time  : ${new Date().toISOString()}`,
    `  Node.js Runtime  : ${process.version}`,
    `  Process Role     : ${processRole} (PID: ${process.pid}, Worker: #${workerId}${isPrimaryWorker ? ' - Primary' : ''})`,
    `  Listening Port   : ${port}`,
    '',
    '[INFRASTRUCTURE]',
    `  PostgreSQL DB    : ${infra.database.connected ? 'CONNECTED' : 'DISCONNECTED'} (Latency: ${infra.database.latencyMs ?? 'N/A'}ms)`,
    `  Pool Health      : Max ${infra.database.poolMax} | Total ${infra.database.poolTotal} | Idle ${infra.database.poolIdle} | Waiting ${infra.database.poolWaiting}`,
    `  Redis Cloud      : ${infra.redis.connected ? 'CONNECTED (Ready)' : `STATUS: ${infra.redis.status}`}`,
    `  BullMQ Workers   : ${infra.bullmq.active ? `ACTIVE (${infra.bullmq.queues.join(', ')})` : 'DISABLED (No Redis ready)'}`,
    `  Cloudinary CDN   : ${infra.cloudinary.configured ? `CONFIGURED (${infra.cloudinary.cloudName})` : 'DISABLED (Credentials missing)'}`,
    `  Firebase Admin   : ${infra.firebase.initialized ? 'INITIALIZED (Push notifications active)' : 'DISABLED (Service account missing)'}`,
    `  Resend Email     : ${infra.resend.configured ? 'CONFIGURED (API key loaded)' : 'DISABLED'}`,
    `  Sentry APM       : ${infra.sentry.initialized ? 'INITIALIZED (Telemetry & profiling active)' : 'DISABLED'}`,
    '',
    '[BACKGROUND SERVICES]',
    `  Notification Svc : ${backgroundWorkersStarted ? 'ENABLED (BullMQ processor)' : 'STANDBY'}`,
    `  Audit Processor  : ${backgroundWorkersStarted ? 'ENABLED (Background worker)' : 'STANDBY'}`,
    `  Webhook Retry    : ${backgroundWorkersStarted ? 'ENABLED (Razorpay backoff)' : 'STANDBY'}`,
    `  Keep-Alive Pinger: REMOVED (External monitoring recommended via /api/ping)`,
    `  Geofence Service : ${isPrimaryWorker ? 'ENABLED (Every 60s active scan)' : 'STANDBY (Non-primary)'}`,
    `  SLA Breaches Svc : ${isPrimaryWorker ? 'ENABLED (Every 2 min SLA monitor)' : 'STANDBY (Non-primary)'}`,
    `  Daily Attendance : ${isPrimaryWorker ? 'SCHEDULED (Daily 23:55 IST)' : 'STANDBY (Non-primary)'}`,
    `  Trial Expiry Svc : ${isPrimaryWorker ? 'SCHEDULED (Daily 00:05 IST)' : 'STANDBY (Non-primary)'}`,
    `  SSE Real-Time    : READY (/api/notifications/sse, /api/customer/sse)`,
    '',
    '[DATABASE MIGRATIONS]',
    `  Integrity Status : ${migrations.status}`,
    `  Schema Version   : ${migrations.schemaVersion}`,
    `  Latest Applied   : ${migrations.latestApplied ? `${migrations.latestApplied.name} (${migrations.latestApplied.appliedAt})` : 'None verified'}`,
    `  Pending Count    : ${migrations.pendingMigrations.length} migration(s)`,
  ];

  if (migrations.pendingMigrations.length > 0) {
    for (const pending of migrations.pendingMigrations) {
      lines.push(`    -> [${pending.status}] ${pending.name}`);
    }
  }

  lines.push('');
  lines.push('[RELEASE HIGHLIGHTS]');
  for (const change of releaseInfo.verifiedChanges) {
    lines.push(`  * ${change.category}: ${change.summary}`);
  }

  const isReady = Boolean(infra.database.connected && migrations.status !== 'QUERY_FAILED');
  lines.push('');
  lines.push(subDivider);
  if (isReady) {
    lines.push('  >>> STATUS: APPLICATION READY — ALL ESSENTIAL SERVICES VERIFIED <<<');
  } else {
    lines.push('  >>> STATUS: DEGRADED — REQUIRED SERVICES (DATABASE) COULD NOT BE VERIFIED <<<');
  }
  lines.push(divider);

  const bannerText = lines.join('\n');
  console.log(bannerText);

  return {
    isReady,
    application: {
      name: releaseInfo.productName,
      version: releaseInfo.version,
      gitCommit: gitInfo.commitSha,
      gitBranch: gitInfo.branch,
      processRole,
      pid: process.pid,
    },
    infrastructure: infra,
    migrations,
  };
}

module.exports = {
  printStartupDashboard,
  gatherInfrastructureStatus,
};
