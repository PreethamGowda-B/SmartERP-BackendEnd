'use strict';

/**
 * Deliver one logical event through exactly one transport path. SSE listeners
 * are registered locally even when Redis is active, so using both transports
 * duplicates delivery to the originating worker's clients.
 */
function deliverUserEvent({ userId, message, redisClient, localBroadcast, onRedisError = () => {} }) {
  const redisAvailable = redisClient && redisClient.status === 'ready';
  if (!redisAvailable) {
    localBroadcast(String(userId), message);
    return 'local';
  }

  Promise.resolve()
    .then(() => redisClient.publish(`employee_notifications:${String(userId)}`, JSON.stringify(message)))
    .catch(onRedisError);
  return 'redis';
}

function notificationRecipientIdempotencyKey(eventKey, recipientId) {
  if (typeof eventKey !== 'string' || !eventKey.trim() || recipientId == null) return null;
  return `${eventKey.trim()}:${String(recipientId)}`;
}

module.exports = { deliverUserEvent, notificationRecipientIdempotencyKey };
