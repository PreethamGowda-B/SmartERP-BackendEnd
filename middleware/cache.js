/**
 * middleware/cache.js
 * Multi-layer caching middleware (In-Memory L1 + Redis L2)
 */

const redisClient = require('../utils/redis');
const NodeCache = require('node-cache');
const localHttpCache = new NodeCache({ stdTTL: 60, checkperiod: 120, maxKeys: 500 });

function cacheMiddleware(duration = 60) {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    const key = `cache:${req.user?.companyId || 'global'}:${req.user?.userId || req.user?.id || 'anon'}:${req.originalUrl}`;

    try {
      // 1. Check fast in-memory L1 cache (0ms)
      const memCached = localHttpCache.get(key);
      if (memCached) {
        return res.json(memCached);
      }

      // 2. Check Redis L2 cache if available
      if (redisClient && redisClient.status === 'ready') {
        const cachedResponse = await redisClient.get(key);
        if (cachedResponse) {
          const parsed = JSON.parse(cachedResponse);
          localHttpCache.set(key, parsed, duration);
          return res.json(parsed);
        }
      }

      // 3. Intercept res.json to populate cache
      const originalJson = res.json;
      res.json = (data) => {
        localHttpCache.set(key, data, duration);

        if (redisClient && redisClient.status === 'ready') {
          redisClient.setex(key, duration, JSON.stringify(data)).catch(err => {
            console.error('Redis Cache Set Error:', err.message);
          });
        }
        return originalJson.call(res, data);
      };

      next();
    } catch (err) {
      console.error('Cache Middleware Error:', err.message);
      next();
    }
  };
}

module.exports = { cacheMiddleware, localHttpCache };
