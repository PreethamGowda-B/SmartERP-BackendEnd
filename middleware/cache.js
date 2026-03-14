/**
 * middleware/cache.js
 * Redis-based caching middleware
 */

const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

function cacheMiddleware(duration = 60) {
  return async (req, res, next) => {
    // Skip caching for non-GET requests
    if (req.method !== 'GET') return next();

    const key = `cache:${req.user?.companyId || 'global'}:${req.originalUrl}`;

    try {
      const cachedResponse = await redis.get(key);
      if (cachedResponse) {
        return res.json(JSON.parse(cachedResponse));
      }

      // Override res.json to store the response in Redis
      const originalJson = res.json;
      res.json = (data) => {
        redis.setex(key, duration, JSON.stringify(data)).catch(err => {
          console.error('Redis Cache Set Error:', err.message);
        });
        return originalJson.call(res, data);
      };

      next();
    } catch (err) {
      console.error('Redis Cache Error:', err.message);
      next();
    }
  };
}

module.exports = { cacheMiddleware };
