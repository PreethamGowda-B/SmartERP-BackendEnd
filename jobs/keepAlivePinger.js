/**
 * 🏓 Render Keep-Alive Pinger (DEPRECATED & REMOVED)
 *
 * Artificial internal self-pinging has been removed per production architecture
 * guidelines to eliminate unnecessary HTTP traffic loops and prevent artificial
 * request spikes.
 *
 * External uptime monitors (such as Render Health Checks, UptimeRobot, or Better Stack)
 * should query the lightweight `/api/ping` (or `/ping`) health endpoint, which responds
 * with HTTP 200 without checking out database connections.
 */

'use strict';

function startKeepAlivePinger() {
  // Deprecated: Internal self-pinging disabled
}

function stopKeepAlivePinger() {
  // No-op
}

module.exports = {
  startKeepAlivePinger,
  stopKeepAlivePinger,
};
