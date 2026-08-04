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

const REDIS_URL = process.env.REDIS_URL;

// ─── Shared options ────────────────────────────────────────────────────────────
const BASE_OPTS = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy(times) {
    if (times > 3) return null; // stop retrying quickly to release slot
    return Math.min(times * 500, 2000);
  },
  lazyConnect: false,
};

// ─── Helper: attach standard error/connect listeners ─────────────────────────
function attachListeners(client, label) {
  client.on('error', (err) => {
    if (err.message?.includes('max number of clients reached')) {
      console.warn(`⚠️ Redis [${label}] connection limit reached (non-fatal)`);
    } else if (
      !err.message?.includes('Connection is closed') &&
      !err.message?.includes('connect ECONNREFUSED') &&
      !err.message?.includes('Stream isn\'t writeable')
    ) {
      console.warn(`⚠️ Redis [${label}] error:`, err.message);
    }
  });
  client.on('connect', () => console.log(`🚀 Redis [${label}] connected`));
}

// ─── Slot 1: Command client ───────────────────────────────────────────────────
let redisClient = null;
if (REDIS_URL) {
  try {
    redisClient = new Redis(REDIS_URL, BASE_OPTS);
    attachListeners(redisClient, 'cmd');
  } catch (e) {
    console.warn('⚠️ Redis command client setup failed:', e.message);
  }
}

// ─── Slot 2: Shared pub/sub subscriber (lazy singleton) ───────────────────────
let subscriberClient = null;
function getSharedSubscriber() {
  if (!REDIS_URL) return null;
  if (subscriberClient) return subscriberClient;
  try {
    subscriberClient = new Redis(REDIS_URL, {
      ...BASE_OPTS,
      // Subscriber connections should retry a bit longer
      retryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 1000, 5000);
      },
    });
    attachListeners(subscriberClient, 'sub');
  } catch (e) {
    console.warn('⚠️ Shared Redis subscriber setup failed:', e.message);
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
  if (bullConnection) return bullConnection;
  try {
    bullConnection = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,  // required by BullMQ
      enableOfflineQueue: true,    // required by BullMQ & ioredis for Worker polling loop
      retryStrategy(times) {
        if (times > 10) return null;
        return Math.min(times * 500, 3000);
      },
    });
    attachListeners(bullConnection, 'bullmq');
  } catch (e) {
    console.warn('⚠️ BullMQ Redis connection setup failed:', e.message);
    bullConnection = null;
  }
  return bullConnection;
}

module.exports = {
  redisClient,
  getSharedSubscriber,
  getBullMQConnection,
};
