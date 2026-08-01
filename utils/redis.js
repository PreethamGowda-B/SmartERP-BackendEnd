const Redis = require("ioredis");

let redisClient = null;
let subscriberClient = null;

const createClientOptions = () => ({
  maxRetriesPerRequest: 1,
  retryStrategy(times) {
    if (times > 5) return null; // stop retrying after 5 attempts to conserve connection quota
    return Math.min(times * 500, 3000);
  },
  enableOfflineQueue: false,
});

if (process.env.REDIS_URL) {
  try {
    redisClient = new Redis(process.env.REDIS_URL, createClientOptions());

    redisClient.on("error", (err) => {
      if (err.message?.includes("max number of clients reached")) {
        console.warn("⚠️ Redis command client limit reached (non-fatal, falling back)");
      } else {
        console.warn("⚠️ Redis command client error:", err.message);
      }
    });

    redisClient.on("connect", () => {
      console.log("🚀 Redis command client connected successfully");
    });
  } catch (e) {
    console.warn("⚠️ Redis command client setup failed:", e.message);
    redisClient = null;
  }
}

function getSharedSubscriber() {
  if (!process.env.REDIS_URL) return null;
  if (subscriberClient) return subscriberClient;

  try {
    subscriberClient = new Redis(process.env.REDIS_URL, createClientOptions());

    subscriberClient.on("error", (err) => {
      if (err.message?.includes("max number of clients reached")) {
        console.warn("⚠️ Shared Redis subscriber limit reached (non-fatal)");
      } else if (err.message !== "Connection is closed." && !err.message?.includes("connect ECONNREFUSED")) {
        console.warn("⚠️ Shared Redis subscriber error:", err.message);
      }
    });

    subscriberClient.on("connect", () => {
      console.log("🚀 Shared Redis subscriber connected successfully");
    });
  } catch (e) {
    console.warn("⚠️ Shared Redis subscriber setup failed:", e.message);
    subscriberClient = null;
  }

  return subscriberClient;
}

module.exports = redisClient;
module.exports.redisClient = redisClient;
module.exports.getSharedSubscriber = getSharedSubscriber;
