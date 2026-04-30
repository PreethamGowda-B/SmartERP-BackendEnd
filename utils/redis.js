const Redis = require("ioredis");

let redisClient = null;

try {
  if (process.env.REDIS_URL) {
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 3) return null; // stop retrying after 3 attempts
        return Math.min(times * 200, 1000);
      },
      // Prevent ioredis from throwing unhandled rejections on connection close
      enableOfflineQueue: false,
    });

    redisClient.on("error", (err) => {
      console.warn("⚠️ Redis client error:", err.message);
    });

    redisClient.on("connect", () => {
      console.log("🚀 Redis connected successfully");
    });

    redisClient.on("close", () => {
      console.warn("⚠️ Redis connection closed");
    });

    redisClient.on("end", () => {
      console.warn("⚠️ Redis connection ended");
    });
  }
} catch (e) {
  console.warn("⚠️ Redis setup failed:", e.message);
  redisClient = null;
}

module.exports = redisClient;
