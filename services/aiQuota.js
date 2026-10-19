const AI_REQUESTS_PER_HOUR = Object.freeze({ starter: 5, professional: 15, enterprise: 30 });

async function consumeAIRequest(redisClient, userId, planTier) {
  if (!userId || !Object.hasOwn(AI_REQUESTS_PER_HOUR, planTier) || !redisClient || redisClient.status !== 'ready') {
    return { allowed: false, status: 503, error: 'AI usage limits are temporarily unavailable. Please retry shortly.' };
  }

  const limit = AI_REQUESTS_PER_HOUR[planTier];
  try {
    const result = await redisClient.eval(
      "local count = redis.call('INCR', KEYS[1]); local ttl = redis.call('TTL', KEYS[1]); if count == 1 or ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]); end; return {count, ttl}",
      1,
      `ai_agent:${userId}`,
      3600
    );
    const count = Number(result?.[0]);
    const retryAfter = Number(result?.[1]);
    if (!Number.isFinite(count)) {
      return { allowed: false, status: 503, error: 'AI usage limits are temporarily unavailable. Please retry shortly.' };
    }
    if (count > limit) {
      return {
        allowed: false,
        status: 429,
        limit,
        count,
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
        error: `AI rate limit reached (${limit} requests/hour for ${planTier} plan). Please retry later.`
      };
    }
    return { allowed: true, limit, count };
  } catch (error) {
    return { allowed: false, status: 503, error: 'AI usage limits are temporarily unavailable. Please retry shortly.' };
  }
}

module.exports = { AI_REQUESTS_PER_HOUR, consumeAIRequest };
