/**
 * jobs/securityWorkerStandalone.js
 *
 * Dedicated 24/7 Standalone Security Background Worker for SmartERP.
 * Can be run as a separate Render Background Worker process or Docker container:
 *   Command: node jobs/securityWorkerStandalone.js
 *
 * Provides:
 * 1. BullMQ Worker for high-throughput, real-time threat detection (via Redis).
 * 2. Database Polling Fallback loop (runs every 30s) if Redis is unavailable,
 *    ensuring continuous 24/7 detection even during Redis maintenance or outages.
 * 3. Graceful shutdown handler for zero-data-loss deployments.
 */

require('dotenv').config();
const { pool } = require('../db');
const { redisClient } = require('../utils/redis');
const { securityWorker, processSecurityIncident } = require('./securityWorker');
const logger = require('../utils/logger');

console.log('🛡️ [SecurityWorkerStandalone] Initializing SmartERP 24/7 Defensive Security Worker...');

let isRunning = true;
let isPollingActive = false;

/**
 * Fallback Database Polling Loop
 * Automatically engages if Redis is offline or disconnected.
 * Polls for recent anomalous events (status >= 400 or security violations)
 * in sliding 15-minute windows and correlates them directly.
 */
async function runDatabasePollingSweep() {
  if (isPollingActive || !isRunning) return;
  isPollingActive = true;

  try {
    // Only engage DB polling if Redis is disconnected or BullMQ is inactive
    const redisReady = redisClient && redisClient.status === 'ready';
    if (redisReady) {
      isPollingActive = false;
      return;
    }

    logger.info('[SecurityWorkerStandalone] Redis offline — executing direct DB polling correlation sweep...');

    // Find distinct source IPs and users from recent high-severity or error events (last 15m)
    const recentRes = await pool.query(`
      SELECT DISTINCT ip_address, user_id, company_id
      FROM security_events
      WHERE created_at > NOW() - INTERVAL '15 minutes'
        AND (
          status_code >= 400
          OR event_type IN ('prompt.injection_attempt', 'tenant.mismatch', 'tenant.idor_attempt', 'admin.unauthorized_access')
        )
      LIMIT 25
    `);

    for (const row of recentRes.rows) {
      try {
        await processSecurityIncident({
          ipAddress: row.ip_address,
          userId: row.user_id,
          companyId: row.company_id,
          trigger: 'db_polling_fallback',
        });
      } catch (procErr) {
        logger.warn(`[SecurityWorkerStandalone] Sweep error for ${row.ip_address || row.user_id}: ${procErr.message}`);
      }
    }
  } catch (err) {
    logger.error(`[SecurityWorkerStandalone] Polling sweep failure: ${err.message}`);
  } finally {
    isPollingActive = false;
  }
}

// Start fallback polling interval (every 30 seconds)
const pollingInterval = setInterval(runDatabasePollingSweep, 30000);

// Heartbeat logger (every 5 minutes)
const heartbeatInterval = setInterval(() => {
  const redisReady = redisClient && redisClient.status === 'ready';
  const bullmqActive = Boolean(securityWorker && !securityWorker.closing && !securityWorker.closed);
  logger.info(`[SecurityWorkerStandalone] Heartbeat: Status=OK | Redis=${redisReady ? 'CONNECTED' : 'OFFLINE'} | BullMQ=${bullmqActive ? 'ACTIVE' : 'STANDBY'}`);
}, 300000);

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n🛑 [SecurityWorkerStandalone] Received ${signal}. Starting graceful shutdown...`);
  isRunning = false;
  clearInterval(pollingInterval);
  clearInterval(heartbeatInterval);

  if (securityWorker) {
    try {
      await securityWorker.close();
      console.log('✅ BullMQ Security Worker closed.');
    } catch (err) {
      console.error('Error closing BullMQ worker:', err.message);
    }
  }

  try {
    await pool.end();
    console.log('✅ PostgreSQL pool closed.');
  } catch (_) {}

  console.log('🛡️ [SecurityWorkerStandalone] Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

console.log('🚀 [SecurityWorkerStandalone] SmartERP 24/7 Security Worker is active.');
