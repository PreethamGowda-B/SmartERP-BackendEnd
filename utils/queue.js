const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

// Connect to Redis (URL will be provided in env)
const redisConnection = process.env.REDIS_URL 
  ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
  : null;

if (redisConnection) {
  redisConnection.on('error', (err) => {
    if (err.message !== 'Connection is closed.') {
      console.warn('⚠️ BullMQ Redis Connection Error:', err.message);
    }
  });
}

/**
 * High-Scale Background Queues
 */
const notificationQueue = redisConnection ? new Queue('notifications', { connection: redisConnection }) : null;
const auditQueue = redisConnection ? new Queue('audit', { connection: redisConnection }) : null;

/**
 * Offload a notification task to the background
 */
async function enqueueNotification(data) {
  if (!notificationQueue) {
    // Fallback to in-memory/immediate if Redis not ready
    console.warn('⚠️ Redis not connected. Processing notification immediately.');
    const { createNotification } = require('./notificationHelpers');
    return createNotification(data);
  }
  return await notificationQueue.add('send', data, { 
    removeOnComplete: true,
    attempts: 3, // Retry up to 3 times
    backoff: {
      type: 'exponential',
      delay: 1000, // Wait 1s, then 2s, then 4s...
    }
  });
}

/**
 * Offload an audit log task to the background
 */
async function enqueueAudit(data) {
  if (!auditQueue) {
    // Redis not available — silently skip audit (non-critical path)
    console.warn('⚠️ Redis not connected. Skipping background audit log.');
    return;
  }
  return await auditQueue.add('log', data, { removeOnComplete: true });
}

module.exports = {
  notificationQueue,
  auditQueue,
  enqueueNotification,
  enqueueAudit,
  redisConnection
};
