const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const Sentry = require("@sentry/node");
const { invalidatePlanCache } = require('../middleware/planMiddleware');
const { storage } = require('../middleware/als');

// ✅ RLS bypass — Razorpay webhooks arrive with no user/tenant session.
router.use((req, res, next) => storage.run({ isWebRequest: true, bypassRls: true }, next));

router.post('/razorpay', async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    
    if (!signature) {
      console.warn('⚠️ [Razorpay Webhook] Missing signature');
      return res.status(400).send('No signature');
    }

    if (!secret) {
      console.error('❌ [Razorpay Webhook] RAZORPAY_WEBHOOK_SECRET is not set');
      return res.status(500).send('Webhook secret not configured');
    }

    // Verify webhook signature (constant-time)
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('hex');

    const sigBufExpected = Buffer.from(expectedSignature, 'utf8');
    const sigBufActual = Buffer.from(signature, 'utf8');
    const signaturesMatch = sigBufExpected.length === sigBufActual.length &&
      crypto.timingSafeEqual(sigBufExpected, sigBufActual);

    if (!signaturesMatch) {
      console.error('❌ [Razorpay Webhook] Invalid signature match');
      return res.status(400).send('Invalid signature');
    }

    const event = req.body;
    
    // We only care about payment.captured
    if (event.event !== 'payment.captured') {
      return res.json({ status: 'ignored' });
    }

    const entity = event.payload.payment.entity;
    const paymentId = entity.id;
    const orderId = entity.order_id;
    const notes = entity.notes || {};
    
    const companyId = parseInt(notes.companyId, 10);
    const planIdInput = parseInt(notes.planId, 10);
    const billingCycle = notes.billingCycle || 'monthly';

    if (!companyId || isNaN(planIdInput)) {
      console.error('❌ [Razorpay Webhook] Missing companyId or planId in notes', notes);
      return res.status(400).send('Missing metadata in notes');
    }

    const planId = planIdInput;

    console.log(`[Razorpay Webhook] Processing capture | Company ID: ${companyId} | Plan ID: ${planId} | Payment ID: ${paymentId}`);

    const dbClient = await pool.connect();

    try {
      await dbClient.query('BEGIN');

      // Advisory lock per company ID ensures strict serial execution per company
      await dbClient.query(`SELECT pg_advisory_xact_lock(hashtext('sub_upgrade_' || $1))`, [String(companyId)]);

      // Row-level lock on companies table
      const compCheck = await dbClient.query(
        `SELECT id, plan_id FROM companies WHERE id = $1 FOR UPDATE`,
        [companyId]
      );

      if (compCheck.rows.length === 0) {
        await dbClient.query('ROLLBACK');
        console.error(`❌ [Razorpay Webhook] Company ID ${companyId} not found in DB`);
        return res.status(404).send('Company record not found');
      }

      // Duplicate Check
      const duplicateCheck = await dbClient.query(
        `SELECT id FROM subscription_events WHERE metadata->>'razorpay_payment_id' = $1`,
        [paymentId]
      );

      if (duplicateCheck.rows.length > 0) {
        await dbClient.query('ROLLBACK');
        console.log(`[Razorpay Webhook] Payment ${paymentId} already processed.`);
        invalidatePlanCache(companyId);
        return res.json({ status: 'ok', message: 'Already processed' });
      }

      // Update Company Plan & Subscription Expiry Dates
      await dbClient.query(
        `UPDATE companies 
         SET plan_id = $1, 
             subscription_status = 'active', 
             is_on_trial = FALSE, 
             subscription_expires_at = COALESCE(GREATEST(subscription_expires_at, NOW()), NOW()) + (CASE WHEN $2 = 'yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END),
             updated_at = NOW()
         WHERE id = $3`,
        [planId, billingCycle, companyId]
      );

      // Log Event
      await dbClient.query(
        `INSERT INTO subscription_events (company_id, event_type, new_plan_id, metadata, created_at)
         VALUES ($1, 'upgrade', $2, $3, NOW())`,
        [companyId, planId, JSON.stringify({ 
          razorpay_payment_id: paymentId, 
          razorpay_order_id: orderId, 
          billingCycle,
          source: 'webhook'
        })]
      );

      await dbClient.query('COMMIT');
      console.log(`[Razorpay Webhook] Transaction Committed Successfully for Company ID: ${companyId}`);
    } catch (txErr) {
      await dbClient.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      dbClient.release();
    }

    // Invalidate Redis Plan Cache
    invalidatePlanCache(companyId);

    // Generate Invoice & Email Owner
    try {
      const planNameMap = { 1: 'Free', 2: 'Basic', 3: 'Pro' };
      const planName = planNameMap[planId] || 'Pro';
      const companyInfo = await pool.query(
        `SELECT c.company_name, c.subscription_expires_at, u.name as owner_name, u.email as owner_email, p.price_monthly, p.price_yearly
         FROM companies c
         LEFT JOIN users u ON u.company_id = c.id AND u.role = 'owner'
         LEFT JOIN plans p ON p.id = $1
         WHERE c.id = $2
         LIMIT 1`,
        [planId, companyId]
      );
      if (companyInfo.rows.length > 0) {
        const info = companyInfo.rows[0];
        const ownerEmail = info.owner_email;
        if (ownerEmail) {
          const ownerName = info.owner_name || 'Owner';
          const invoiceNumber = `INV-SUB-${new Date().getFullYear()}-${String(companyId).padStart(4, '0')}-${Date.now().toString().slice(-4)}`;
          const paidAmount = billingCycle === 'yearly' ? info.price_yearly : info.price_monthly;

          const { sendSubscriptionInvoiceEmail } = require('../services/emailNotificationService');
          sendSubscriptionInvoiceEmail({
            ownerEmail,
            ownerName,
            companyName: info.company_name,
            planName,
            billingCycle,
            amount: paidAmount,
            invoiceNumber,
            paymentId,
            orderId,
            expiryDate: info.subscription_expires_at
          }).catch(e => console.error('[Webhook] Error sending invoice email:', e.message));
        }
      }
    } catch (invErr) {
      console.error('⚠️ [Webhook] Failed to generate/send invoice email:', invErr.message);
    }

    res.json({ status: 'ok', message: 'Subscription activated via webhook' });
  } catch (err) {
    console.error('❌ [Razorpay Webhook] Error:', err);

    // Enqueue background retry job with BullMQ (3 attempts with exponential backoff)
    try {
      const { enqueueWebhookRetry } = require('../utils/queue');
      const event = req.body || {};
      const entity = event.payload?.payment?.entity || {};
      const notes = entity.notes || {};
      const companyId = parseInt(notes.companyId, 10) || 0;
      const planId = parseInt(notes.planId, 10) || null;

      await enqueueWebhookRetry({
        companyId,
        planId,
        billingCycle: notes.billingCycle || 'monthly',
        paymentId: entity.id || null,
        orderId: entity.order_id || null,
        error: err.message
      });

      if (companyId) {
        await pool.query(
          `INSERT INTO subscription_events (company_id, event_type, new_plan_id, metadata, created_at)
           VALUES ($1, 'webhook_retry_enqueued', $2, $3, NOW())`,
          [companyId, planId, JSON.stringify({
            razorpay_payment_id: entity.id,
            error: err.message,
            enqueued_at: new Date().toISOString()
          })]
        ).catch(() => {});
      }
    } catch (retryErr) {
      console.error('❌ Could not enqueue webhook retry job:', retryErr.message);
    }

    res.status(500).send('Internal server error');
  }
});

module.exports = router;
