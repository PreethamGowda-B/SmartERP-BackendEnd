/**
 * middleware/cache.js
 * Multi-layer caching middleware (In-Memory L1 + Redis L2)
 * Features instant invalidation on mutations and bypass support for manual refresh.
 */

'use strict';

const redisClient = require('../utils/redis');
const NodeCache = require('node-cache');
const localHttpCache = new NodeCache({ stdTTL: 60, checkperiod: 120, maxKeys: 1000 });

const CACHE_INVALIDATION_CHANNEL = 'smarterp:cache:invalidation';
let subscriberInitialized = false;

function initHttpCacheCrossWorkerSync() {
  if (subscriberInitialized) return;
  try {
    const { getSharedSubscriber } = require('../utils/redis');
    const subscriber = getSharedSubscriber();
    if (!subscriber) return;

    subscriber.subscribe(CACHE_INVALIDATION_CHANNEL, (err) => {
      if (!err) subscriberInitialized = true;
    });

    subscriber.on('message', (channel, message) => {
      if (channel === CACHE_INVALIDATION_CHANNEL) {
        try {
          const payload = JSON.parse(message);
          if (payload?.type === 'http_cache' && payload.companyId) {
            purgeLocalCompanyCache(payload.companyId);
          }
        } catch {}
      }
    });
  } catch {}
}

function purgeLocalCompanyCache(companyId) {
  if (!companyId) return;
  const prefix = `cache:${companyId}:`;
  const keys = localHttpCache.keys();
  for (const k of keys) {
    if (k.startsWith(prefix)) {
      localHttpCache.del(k);
    }
  }
}

initHttpCacheCrossWorkerSync();

function cacheMiddleware(duration = 60) {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Allow manual bypass via query or header
    if (req.query?.skipCache === 'true' || req.headers['cache-control'] === 'no-cache') {
      return next();
    }

    const companyId = req.user?.companyId || 'global';
    const userId = req.user?.userId || req.user?.id || 'anon';
    const role = req.user?.role || 'anon';
    const key = `cache:${companyId}:${role}:${userId}:${req.originalUrl}`;

    try {
      // 1. Check fast in-memory L1 cache (0ms)
      const memCached = localHttpCache.get(key);
      if (memCached) {
        res.setHeader('X-Cache', 'HIT-L1');
        return res.json(memCached);
      }

      // 2. Check Redis L2 cache if available
      if (redisClient && redisClient.status === 'ready') {
        const cachedResponse = await redisClient.get(key);
        if (cachedResponse) {
          const parsed = JSON.parse(cachedResponse);
          localHttpCache.set(key, parsed, duration);
          res.setHeader('X-Cache', 'HIT-L2');
          return res.json(parsed);
        }
      }

      // 3. Intercept res.json to populate cache
      const originalJson = res.json;
      res.json = (data) => {
        // Only cache successful JSON responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          localHttpCache.set(key, data, duration);

          if (redisClient && redisClient.status === 'ready') {
            redisClient.setex(key, duration, JSON.stringify(data)).catch(() => {});
          }
        }
        res.setHeader('X-Cache', 'MISS');
        return originalJson.call(res, data);
      };

      next();
    } catch (err) {
      console.error('Cache Middleware Error:', err.message);
      next();
    }
  };
}

/**
 * Invalidate all cached HTTP responses for a specific company
 * @param {string|number} companyId
 */
function invalidateHttpCache(companyId) {
  if (!companyId) return;
  purgeLocalCompanyCache(companyId);

  if (redisClient && redisClient.status === 'ready') {
    const prefix = `cache:${companyId}:`;
    // Scan and delete in Redis
    redisClient.keys(`${prefix}*`).then((keysToDelete) => {
      if (keysToDelete && keysToDelete.length > 0) {
        redisClient.del(...keysToDelete).catch(() => {});
      }
    }).catch(() => {});

    // Broadcast invalidation event to peer instances
    redisClient.publish(CACHE_INVALIDATION_CHANNEL, JSON.stringify({
      type: 'http_cache',
      companyId: String(companyId),
      timestamp: Date.now()
    })).catch(() => {});
  }
}

module.exports = { cacheMiddleware, localHttpCache, invalidateHttpCache };
