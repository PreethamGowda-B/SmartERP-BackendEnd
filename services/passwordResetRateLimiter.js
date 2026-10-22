async function checkPasswordResetRateLimit(redisClient, key, { maximum = 5, windowSeconds = 900 } = {}) {
  if (!redisClient || redisClient.status !== "ready") {
    return { allowed: true, unavailable: true };
  }

  try {
    const count = Number(await redisClient.incr(key));
    if (count === 1) await redisClient.expire(key, windowSeconds);
    if (count > maximum) {
      const retryAfter = Number(await redisClient.ttl(key));
      return { allowed: false, retryAfter };
    }
    return { allowed: true, count };
  } catch {
    // Match the existing endpoint behavior: a Redis outage must not reveal
    // account existence or permanently prevent a user from recovering access.
    return { allowed: true, unavailable: true };
  }
}

module.exports = { checkPasswordResetRateLimit };
