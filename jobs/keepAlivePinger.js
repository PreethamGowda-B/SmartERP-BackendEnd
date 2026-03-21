const cron = require('node-cron');
const https = require('https');
const http = require('http');

const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || 'http://localhost:4000';

/**
 * 🏓 Render Keep-Alive Pinger
 * Hits /api/health every 10 minutes to prevent Render's free tier
 * from spinning down the container after 15 mins of inactivity.
 * Only runs in production.
 */
function startKeepAlivePinger() {
  if (process.env.NODE_ENV !== 'production') {
    console.log('⏭️  Keep-alive pinger skipped (not production)');
    return;
  }

  console.log(`🏓 Keep-alive pinger started → ${BACKEND_URL}/api/health (every 10 min)`);

  // Run every 10 minutes
  cron.schedule('*/10 * * * *', () => {
    const url = `${BACKEND_URL}/api/health`;
    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, (res) => {
      console.log(`🏓 Keep-alive ping → ${res.statusCode} (${new Date().toISOString()})`);
    });

    req.on('error', (err) => {
      console.warn(`⚠️ Keep-alive ping failed: ${err.message}`);
    });

    req.setTimeout(10000, () => {
      console.warn('⚠️ Keep-alive ping timed out');
      req.destroy();
    });
  });
}

module.exports = { startKeepAlivePinger };
