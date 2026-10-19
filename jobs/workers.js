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
    console.log(`📋 Processing audit job ${job.id} for user ${job.data.userId}`);
  }, { connection: redisConnection });

  /**
   * Razorpay Webhook Retry Worker
   * Retries failed webhook subscription processing (3 max attempts with exponential backoff)
   */
  const { pool } = require('../db');
  const { invalidatePlanCache } = require('../middleware/planMiddleware');
  const Razorpay = require('razorpay');
  const { getPlan, getPricePaise, paymentMatchesOrder, isRazorpayConfigured } = require('../services/subscriptionCatalog');

  const webhookWorker = new Worker('webhook-retry', async (job) => {
    const { companyId, planId, billingCycle, paymentId, orderId, purpose } = job.data;

    // Retry worker only handles plan purchases. Trial activation is handled by
    // the signature-verified Razorpay webhook and must not be converted into a paid plan.
    if (purpose !== 'plan_purchase') {
      console.warn('[Webhook Worker] Skipping retry without an explicit plan_purchase purpose.');
      return;
    }
    const currentAttempt = (job.attemptsMade || 0) + 1;
    console.log(`🔄 Webhook Retry Worker | Job ID: ${job.id} | Company: ${companyId} | Attempt ${currentAttempt}/3`);

    // Queue payloads are not proof of payment. Re-fetch from Razorpay on every retry
    // before applying any subscription change.
    if (!companyId || !paymentId || !orderId || ![2, 3].includes(Number(planId)) || !['monthly', 'yearly'].includes(billingCycle)) {
      throw new Error('Webhook retry is missing valid payment metadata');
    }
    if (!isRazorpayConfigured()) throw new Error('Razorpay verification is not configured');
    const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    const [order, payment] = await Promise.all([
      razorpay.orders.fetch(orderId),
      razorpay.payments.fetch(paymentId)
    ]);
    if (!paymentMatchesOrder({
      order, payment, companyId, purpose: 'plan_purchase', planId: Number(planId), billingCycle,
      expectedAmountPaise: getPricePaise(Number(planId), billingCycle)
    })) {
      throw new Error('Provider payment does not match the queued subscription purchase');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sub_payment_' || $1))", [String(paymentId)]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('sub_upgrade_' || $1))`, [String(companyId)]);

      const compCheck = await client.query(
        `SELECT id FROM companies WHERE id = $1 FOR UPDATE`,
        [companyId]
      );
      if (compCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Company ID ${companyId} not found`);
      }

      // Check duplicate
      const duplicateCheck = await client.query(
        `SELECT company_id FROM subscription_events WHERE metadata->>'razorpay_payment_id' = $1`,
        [paymentId]
      );
      if (duplicateCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        if (String(duplicateCheck.rows[0].company_id) !== String(companyId)) throw new Error('Payment was already applied to another company');
        console.log(`[Webhook Worker] Payment ${paymentId} already processed.`);
        invalidatePlanCache(companyId);
        return;
      }

      await client.query(
        `UPDATE companies 
         SET plan_id = $1, 
             subscription_status = 'active', 
             is_on_trial = FALSE, 
             subscription_expires_at = (CASE WHEN is_on_trial THEN NOW() WHEN subscription_expires_at > NOW() THEN subscription_expires_at ELSE NOW() END) + (CASE WHEN $2 = 'yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END),
             updated_at = NOW()
         WHERE id = $3`,
        [planId, billingCycle || 'monthly', companyId]
      );

      await client.query(
        `INSERT INTO subscription_events (company_id, event_type, new_plan_id, metadata, created_at)
         VALUES ($1, 'upgrade', $2, $3, NOW())`,
        [companyId, planId, JSON.stringify({ 
          razorpay_payment_id: paymentId, 
          razorpay_order_id: orderId, 
          billingCycle,
          source: 'webhook_retry_worker',
          attempt: currentAttempt
        })]
      );

      await client.query('COMMIT');
      invalidatePlanCache(companyId);
      console.log(`✅ Webhook Retry Succeeded on attempt ${currentAttempt} for Company ${companyId}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`❌ Webhook Retry attempt ${currentAttempt} failed:`, err.message);

      // Log retry attempt failure to subscription_events table
      await pool.query(
        `INSERT INTO subscription_events (company_id, event_type, new_plan_id, metadata, created_at)
         VALUES ($1, 'webhook_retry_attempt_failed', $2, $3, NOW())`,
        [companyId || 0, planId || null, JSON.stringify({
          razorpay_payment_id: paymentId,
          attempt: currentAttempt,
          error: err.message
        })]
      ).catch(() => {});

      throw err; // Trigger BullMQ retry mechanism
    } finally {
      client.release();
    }
  }, { connection: redisConnection });

  notificationWorker.on('completed', (job) => {
    console.log(`✅ Notification job ${job.id} finished`);
  });

  auditWorker.on('completed', (job) => {
    console.log(`✅ Audit job ${job.id} finished`);
  });

  // Security Worker (SmartERP Defensive Security AI)
  const { securityWorker } = require('./securityWorker');
  if (securityWorker) {
    securityWorker.on('completed', (job) => {
      console.log(`✅ Security analysis job ${job.id} finished`);
    });
  }

  console.log('🚀 Redis Workers Initialized (Notifications, Audit, Webhook Retry, & Security AI)');
} else {
  console.warn('⚠️ No Redis connection - Background Workers NOT started.');
}
