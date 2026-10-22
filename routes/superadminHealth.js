const express = require('express');
const router = express.Router();
const os = require('os');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { authenticateSuperAdmin } = require('../middleware/adminMiddleware');

function toCount(result) {
  const count = Number(result?.rows?.[0]?.count);
  return Number.isFinite(count) ? count : null;
}

function createHealthMetricsHandler({
  query = pool.query.bind(pool),
  now = Date.now,
  memoryUsage = process.memoryUsage.bind(process),
  uptime = process.uptime.bind(process),
  operatingSystem = os,
} = {}) {
  return async (_req, res) => {
    const startedAt = now();
    try {
      await query('SELECT 1');
      const dbLatencyMs = Math.max(0, now() - startedAt);
      const countQueries = [
        ['active_users', "SELECT count(*) AS count FROM users WHERE COALESCE(is_active, TRUE) = TRUE"],
        ['active_companies', "SELECT count(*) AS count FROM companies WHERE COALESCE(status, 'active') = 'active'"],
        ['total_jobs_processed', 'SELECT count(*) AS count FROM jobs'],
        ['total_audit_events', 'SELECT count(*) AS count FROM activities'],
      ];
      const counts = await Promise.all(countQueries.map(async ([key, sql]) => {
        try {
          return [key, toCount(await query(sql))];
        } catch (error) {
          console.warn(`[superadmin-health] Metric ${key} unavailable: ${error.message}`);
          return [key, null];
        }
      }));
      const measuredCounts = Object.fromEntries(counts);
      const unavailableMetrics = [
        ...Object.entries(measuredCounts).filter(([, value]) => value === null).map(([key]) => key),
        'api_avg_response_ms',
        'active_sse_connections',
        'notification_delivery_rate',
        'ai_request_success_rate',
      ];
      const mem = memoryUsage();
      const freeMem = operatingSystem.freemem();
      const totalMem = operatingSystem.totalmem();

      return res.json({
        success: true,
        health: {
          status: unavailableMetrics.length > 0 ? 'degraded' : 'healthy',
          db_latency_ms: dbLatencyMs,
          api_avg_response_ms: null,
          ...measuredCounts,
          active_sse_connections: null,
          notification_delivery_rate: null,
          ai_request_success_rate: null,
          unavailable_metrics: unavailableMetrics,
          process: {
            uptime_seconds: Math.floor(uptime()),
            heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
            heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
            rss_mb: Math.round(mem.rss / 1024 / 1024),
          },
          system: {
            os_type: operatingSystem.type(),
            os_platform: operatingSystem.platform(),
            cpus: operatingSystem.cpus().length,
            free_memory_mb: Math.round(freeMem / 1024 / 1024),
            total_memory_mb: Math.round(totalMem / 1024 / 1024),
          },
        },
      });
    } catch (error) {
      console.error('[superadmin-health] Database health check failed:', error.message);
      return res.status(503).json({
        success: false,
        health: { status: 'unavailable', db_latency_ms: null },
        message: 'Database health check is unavailable.',
      });
    }
  };
}

router.get('/', authenticateToken, authenticateSuperAdmin, createHealthMetricsHandler());

module.exports = router;
module.exports.createHealthMetricsHandler = createHealthMetricsHandler;
