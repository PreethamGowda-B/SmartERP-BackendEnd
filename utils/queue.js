/**
 * utils/queue.js
 *
 * BullMQ background queues — notifications and audit logs.
 *
 * Uses the centralized BullMQ Redis connection from utils/redis.js
 * (getBullMQConnection) to avoid creating a separate connection and
 * blowing through Upstash's free-tier connection limit.
 *
 * BullMQ internally creates one extra "events" connection per Queue,
 * so 2 Queues here = 1 shared base connection + 2 event listeners.
 * We disable the events connection to save connection slots.
 */

const { Queue } = require('bullmq');
const { getBullMQConnection } = require('./redis');

// Lazy: only connect if REDIS_URL is set
const connection = getBullMQConnection();

// BullMQ Queue options — disable internal event connections to save slots
const QUEUE_OPTS = {
  connection,
  // Disable the events stream subscription (saves 1 connection per Queue)
  streams: { events: { maxLen: 0 } },
};

const notificationQueue = connection
  ? new Queue('notifications', QUEUE_OPTS)
  : null;

const auditQueue = connection
  ? new Queue('audit', QUEUE_OPTS)
  : null;

/**
 * Offload a notification task to the background queue.
 * Falls back to synchronous creation if BullMQ is unavailable.
 */
async function enqueueNotification(data) {
  if (!notificationQueue) {
    const { createNotification } = require('./notificationHelpers');
    return createNotification(data);
  }
  const opts = {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  };
  if (data.idempotency_key) {
    opts.jobId = String(data.idempotency_key);
  }
  return notificationQueue.add('send', data, opts);
}

/**
 * Offload a company-wide broadcast notification task to the background queue.
 * Falls back to direct execution if BullMQ is unavailable.
 */
async function enqueueCompanyNotification(data) {
  if (!notificationQueue) {
    const { createNotificationForCompany } = require('./notificationHelpers');
    return createNotificationForCompany(data);
  }
  const opts = {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  };
  if (data.idempotency_key) {
    opts.jobId = `comp:${String(data.idempotency_key)}`;
  }
  return notificationQueue.add('send', { ...data, isCompanyNotification: true }, opts);
}

/**
 * Offload an audit log task to the background queue.
 * Falls back to direct logJobAudit if BullMQ is unavailable.
 */
async function enqueueAudit(data) {
  if (!auditQueue) {
    const { logJobAudit } = require('./auditLogger');
    return logJobAudit(data);
  }
  return auditQueue.add('log', data, { removeOnComplete: true, attempts: 2 });
}

const webhookRetryQueue = connection
  ? new Queue('webhook-retry', QUEUE_OPTS)
  : null;

/**
 * Offload a failed webhook event to background queue for exponential retries (3 attempts).
 */
async function enqueueWebhookRetry(data) {
  if (!webhookRetryQueue) {
    console.warn('⚠️ Redis not connected. Skipping background webhook retry.');
    return;
  }
  return webhookRetryQueue.add('process_failed_webhook', data, {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

const securityQueue = connection
  ? new Queue('security-detection', QUEUE_OPTS)
  : null;

/**
 * Offload a security incident triage task to the background queue.
 */
async function enqueueSecurityEvent(data) {
  if (!securityQueue) {
    return;
  }
  return securityQueue.add('analyze_incident', data, {
    removeOnComplete: true,
    attempts: 2,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

module.exports = {
  notificationQueue,
  auditQueue,
  webhookRetryQueue,
  securityQueue,
  enqueueNotification,
  enqueueCompanyNotification,
  enqueueAudit,
  enqueueWebhookRetry,
  enqueueSecurityEvent,
  closeQueues: async () => {
    await Promise.allSettled([notificationQueue, auditQueue, webhookRetryQueue, securityQueue]
      .filter(Boolean)
      .map((queue) => queue.close()));
  },
  // Expose so callers that previously used redisConnection can migrate
  redisConnection: connection,
};
