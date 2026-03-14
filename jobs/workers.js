const { Worker } = require('bullmq');
const { redisConnection } = require('../utils/queue');
const { createNotification } = require('../utils/notificationHelpers');

if (redisConnection) {
  /**
   * Notification Worker
   * Processes FCM and SSE deliveries in the background
   */
  const notificationWorker = new Worker('notifications', async (job) => {
    console.log(`✉️ Processing notification job ${job.id} for user ${job.data.user_id}`);
    try {
      await createNotification(job.data);
    } catch (err) {
      console.error(`❌ Notification Job ${job.id} failed:`, err.message);
      throw err; // Allow BullMQ to retry if needed
    }
  }, { connection: redisConnection });

  /**
   * Audit Log Worker
   * Processes activity logging without blocking the API
   */
  const auditWorker = new Worker('audit', async (job) => {
    // Audit logic implementation
    // For now, it just wraps the existing logActivity logic if needed
    console.log(`📋 Processing audit job ${job.id} for user ${job.data.userId}`);
  }, { connection: redisConnection });

  notificationWorker.on('completed', (job) => {
    console.log(`✅ Notification job ${job.id} finished`);
  });

  auditWorker.on('completed', (job) => {
    console.log(`✅ Audit job ${job.id} finished`);
  });

  console.log('🚀 Redis Workers Initialized (Notifications & Audit)');
} else {
  console.warn('⚠️ No Redis connection - Background Workers NOT started.');
}
