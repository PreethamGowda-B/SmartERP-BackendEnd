const Redis = require("ioredis");

let redisClient = null;

try {
  if (process.env.REDIS_URL) {
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true, // Don't crash if Redis is down on startup
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      // Prevent ioredis from throwing unhandled rejections on connection close
      enableOfflineQueue: false,
      reconnectOnError(err) {
        const targetError = "READONLY";
        if (err.message.includes(targetError)) {
          return true; // Reconnect on READONLY errors
        }
        return false;
      },
    });

    redisClient.on("error", (err) => {
      // Suppress "Connection is closed" noise in logs since we handle it in middleware
      if (err.message !== "Connection is closed.") {
        console.warn("⚠️ Redis client error:", err.message);
      }
    });

    redisClient.on("connect", () => {
      console.log("🚀 Redis connected successfully");
    });
  }
} catch (e) {
  console.warn("⚠️ Redis setup failed:", e.message);
  redisClient = null;
}

module.exports = redisClient;
