const cron = require('node-cron');
const https = require('https');
const http = require('http');
const logger = require('../utils/logger');

const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || 'http://localhost:4000';
let keepAliveTask = null;
let isPingInProgress = false;

/**
 * 🏓 Render Keep-Alive Pinger
 * Hits /api/health every 10 minutes to prevent Render's free tier
 * from spinning down the container after 15 mins of inactivity.
 * Only runs in production.
 *
 * NOTE: Uses an in-memory guard rather than a PostgreSQL advisory lock
 * to avoid checking out scarce database connections during outbound HTTP requests.
 */
function startKeepAlivePinger() {
  if (keepAliveTask) return;
  if (process.env.NODE_ENV !== 'production') {
    logger.debug('Keep-alive pinger skipped (not production)');
    return;
  }

  logger.info(`Keep-alive pinger started for ${BACKEND_URL}/api/health (every 10 min)`, { pid: process.pid });

  // Run every 10 minutes
  keepAliveTask = cron.schedule('*/10 * * * *', () => {
    if (isPingInProgress) {
      logger.debug('Keep-alive ping already in progress, skipping this tick');
      return;
    }
    isPingInProgress = true;

    const url = `${BACKEND_URL}/api/health`;
    const client = url.startsWith('https') ? https : http;
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        isPingInProgress = false;
      }
    };

    const req = client.get(url, (res) => {
      res.resume();
      res.once('close', finish);
      res.once('end', () => {
        logger.debug(`Keep-alive ping -> ${res.statusCode}`, { statusCode: res.statusCode, timestamp: new Date().toISOString() });
        finish();
      });
    });
    req.on('error', (err) => {
      logger.warn(`Keep-alive ping failed: ${err.message}`, { error: err.message });
      finish();
    });
    req.setTimeout(10000, () => {
      logger.warn('Keep-alive ping timed out');
      req.destroy();
      finish();
    });
  });
}

function stopKeepAlivePinger() {
  keepAliveTask?.stop();
  keepAliveTask = null;
}

module.exports = { startKeepAlivePinger, stopKeepAlivePinger };
