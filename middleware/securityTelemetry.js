/**
 * middleware/securityTelemetry.js
 *
 * Lightweight security telemetry middleware for SmartERP.
 * Detects route enumeration, scanner probes, and anomalous error surges
 * without intercepting or slowing down legitimate business traffic.
 */

const { emitSecurityEvent, SECURITY_EVENT_TYPES } = require('../utils/securityEmitter');
const { redisClient } = require('../utils/redis');

// Known high-risk scanning paths probed by automated bots
const KNOWN_SCAN_PATTERNS = [
  /^\/\.env/i,
  /^\/\.git/i,
  /^\/wp-login\.php/i,
  /^\/wp-admin/i,
  /^\/phpmyadmin/i,
  /^\/admin\.php/i,
  /^\/actuator/i,
  /^\/swagger-ui/i,
  /^\/\.aws/i,
  /^\/shell/i,
  /^\/config\.json/i,
];

function isKnownScanPath(path) {
  return KNOWN_SCAN_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Express middleware to track route scans and enumeration patterns.
 */
function securityTelemetryMiddleware(req, res, next) {
  const path = req.path || req.originalUrl || '';
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';

  // 1. Immediate scan detection for well-known exploit probes
  if (isKnownScanPath(path)) {
    emitSecurityEvent({
      eventType: SECURITY_EVENT_TYPES.ROUTE_SCAN,
      severity: 'medium',
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
      endpoint: path.slice(0, 255),
      httpMethod: req.method,
      statusCode: 404,
      metadata: {
        pattern: 'known_vulnerability_probe',
      },
    });
  }

  // 2. Hook response 'finish' event to track high-frequency 404/403 route sweeps
  res.on('finish', () => {
    // Only inspect 404s and 403s on non-static assets
    if (res.statusCode === 404 && !path.startsWith('/_next') && !path.startsWith('/static')) {
      if (redisClient && redisClient.status === 'ready' && ip !== 'unknown') {
        const scanKey = `route_scan_404:${ip}`;
        redisClient.incr(scanKey).then((count) => {
          if (count === 1) {
            redisClient.expire(scanKey, 180); // 3-minute sliding window
          }
          if (count === 15) {
            emitSecurityEvent({
              eventType: SECURITY_EVENT_TYPES.ROUTE_SCAN,
              severity: 'medium',
              ipAddress: ip,
              userAgent: req.headers['user-agent'],
              endpoint: path.slice(0, 255),
              httpMethod: req.method,
              statusCode: 404,
              metadata: {
                totalNotFoundInWindow: count,
                pattern: 'rapid_endpoint_enumeration',
              },
            });
          }
        }).catch(() => {});
      }
    }
  });

  next();
}

module.exports = {
  securityTelemetryMiddleware,
  isKnownScanPath,
};
