/**
 * utils/redis.js
 *
 * Exports a single Redis singleton for command use and a shared pub/sub
 * subscriber singleton. All connection creation is centralized here to
 * prevent multiple connections blowing through Upstash's free-tier limit
 * (10 max simultaneous clients).
 *
 * Connection budget (worst case startup):
 *   slot 1 → redisClient (command client, used by all routes)
 *   slot 2 → subscriberClient (shared pub/sub, used by SSE)
 *   slot 3 → BullMQ connection (producer)
 *   slot 4 → BullMQ internal events connection (auto-created by BullMQ)
 *   ─────────────────────────────────────────
 *   Total: 4 connections max — well within the 10-client limit
 */

const Redis = require('ioredis');
const logger = require('./logger');
const { instrumentRedisClient } = require('./outboundBandwidth');

const REDIS_URL = process.env.REDIS_URL;

// ─── Shared options ────────────────────────────────────────────────────────────
const BASE_OPTS = {
  maxRetriesPerRequest: 3,
  enableOfflineQueue: true,
  retryStrategy(times) {
    // Reconnect with capped backoff; avoid permanent client abandonment on transient network drops
    return Math.min(times * 300, 3000);
  },
  lazyConnect: false,
};

// ─── Helper: attach standard error/connect listeners ─────────────────────────
function attachListeners(client, label) {
  client.on('error', (err) => {
    if (err.message?.includes('max number of clients reached')) {
      logger.warn(`Redis [${label}] connection limit reached (non-fatal)`, { label, pid: process.pid });
    } else if (
      !err.message?.includes('Connection is closed') &&
      !err.message?.includes('connect ECONNREFUSED') &&
      !err.message?.includes('Stream isn\'t writeable') &&
      !err.message?.includes("Can't execute 'info'")
    ) {
      logger.warn(`Redis [${label}] error: ${err.message}`, { label, pid: process.pid });
    }
  });
  client.on('connect', () => {
    const remoteAddress = client.stream?.remoteAddress;
    const networkClass = require('./outboundBandwidth').classifyAddress(remoteAddress);
    logger.info(`Redis [${label}] connected`, { label, pid: process.pid, networkClass });
  });
}

// ─── Slot 1: Command client ───────────────────────────────────────────────────
let redisClient = null;
if (REDIS_URL) {
  try {
    redisClient = instrumentRedisClient(new Redis(REDIS_URL, BASE_OPTS));
    attachListeners(redisClient, 'cmd');
  } catch (e) {
    logger.warn(`Redis command client setup failed: ${e.message}`, { pid: process.pid });
  }
}

// ─── Slot 2: Shared pub/sub subscriber (lazy singleton) ───────────────────────
let subscriberClient = null;
function getSharedSubscriber() {
  if (!REDIS_URL) return null;
  if (subscriberClient && subscriberClient.status !== 'end') return subscriberClient;
  try {
    subscriberClient = instrumentRedisClient(new Redis(REDIS_URL, {
      ...BASE_OPTS,
      enableOfflineQueue: true, // Allow subscribe commands to buffer until TCP connection opens
      maxRetriesPerRequest: null,
      // Subscriber connections retry with backoff to stay alive
      retryStrategy(times) {
        return Math.min(times * 500, 5000);
      },
    }));
    attachListeners(subscriberClient, 'sub');
  } catch (e) {
    logger.warn(`Shared Redis subscriber setup failed: ${e.message}`, { pid: process.pid });
    subscriberClient = null;
  }
  return subscriberClient;
}

// ─── Slot 3: BullMQ connection (lazy singleton) ───────────────────────────────
// BullMQ requires maxRetriesPerRequest: null and enableOfflineQueue: true.
// We expose this via a getter so queue.js can reuse the same connection
// instead of creating a new one on import.
let bullConnection = null;
function getBullMQConnection() {
  if (!REDIS_URL) return null;
  if (bullConnection && bullConnection.status !== 'end') return bullConnection;
  try {
    bullConnection = instrumentRedisClient(new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,  // required by BullMQ
      enableOfflineQueue: true,    // required by BullMQ & ioredis for Worker polling loop
      retryStrategy(times) {
        return Math.min(times * 500, 3000);
      },
    }));
    attachListeners(bullConnection, 'bullmq');
  } catch (e) {
    logger.warn(`BullMQ Redis connection setup failed: ${e.message}`, { pid: process.pid });
    bullConnection = null;
  }
  return bullConnection;
}

module.exports = {
  redisClient,
  getSharedSubscriber,
  getBullMQConnection,
  closeRedisConnections: async () => {
    const clients = [redisClient, subscriberClient, bullConnection].filter(Boolean);
    await Promise.allSettled(clients.map(async (client) => {
      if (client.status === 'end') return;
      if (client.status === 'ready') await client.quit();
      else client.disconnect();
    }));
  },
};
