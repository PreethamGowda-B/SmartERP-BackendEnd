const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const Sentry = require("@sentry/node");
const { invalidatePlanCache } = require('../middleware/planMiddleware');
const { storage } = require('../middleware/als');
const Razorpay = require('razorpay');
const { getPlan, getPricePaise, paymentMatchesOrder, isRazorpayConfigured } = require('../services/subscriptionCatalog');
const { recordPendingSubscriptionPayment, recordCapturedSubscriptionPayment, recordSubscriptionPaymentAttempt } = require('../services/subscriptionPayments');

// Razorpay has no user session. Keep its privileged scope on this signed
// callback only rather than granting it to every route added to this router.
router.post('/razorpay', (req, res, next) => {
  storage.run({ isWebRequest: true, bypassRls: true }, next);
}, async (req, res) => {
  let verifiedOrderPurpose = null;
  let verifiedOrderNotes = null;
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

    // Verify webhook signature (constant-time) with dual-secret rotation support
    const verifySignatureAgainstSecret = (sec) => {
      if (!sec) return false;
      const expected = crypto.createHmac('sha256', sec).update(req.rawBody).digest('hex');
      const sigBufExpected = Buffer.from(expected, 'utf8');
      const sigBufActual = Buffer.from(signature, 'utf8');
      return sigBufExpected.length === sigBufActual.length &&
        crypto.timingSafeEqual(sigBufExpected, sigBufActual);
    };

    let signaturesMatch = verifySignatureAgainstSecret(secret);

    // If primary secret failed and an OLD secret is configured during rotation grace period, check fallback
    if (!signaturesMatch && process.env.RAZORPAY_WEBHOOK_SECRET_OLD) {
      signaturesMatch = verifySignatureAgainstSecret(process.env.RAZORPAY_WEBHOOK_SECRET_OLD);
      if (signaturesMatch) {
        console.log('ℹ️ [Razorpay Webhook] Signature verified using fallback RAZORPAY_WEBHOOK_SECRET_OLD');
      }
    }

    if (!signaturesMatch) {
      console.error('❌ [Razorpay Webhook] Invalid signature match');
      return res.status(400).send('Invalid signature');
    }

    const event = req.body;
    
    // Subscription access is granted only for captured payments. Persist
    // authorized/failed attempts for retry support, but never activate access.
    if (!['payment.captured', 'payment.authorized', 'payment.failed'].includes(event.event)) {
      return res.json({ status: 'ignored' });
    }

    const entity = event.payload?.payment?.entity;
    if (!entity?.id || !entity?.order_id) return res.status(400).send('Payment payload is incomplete');
    const paymentId = entity.id;
    const orderId = entity.order_id;
    if (!isRazorpayConfigured()) return res.status(503).send('Payment provider is not configured');
    const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    let order;
    try { order = await razorpay.orders.fetch(orderId); }
    catch (error) {
      console.error('[Razorpay Webhook] Unable to load associated order:', error.message);
      return res.status(502).send('Could not verify associated order');
    }
    const notes = order.notes || {};
    verifiedOrderNotes = notes;
    verifiedOrderPurpose = notes.purpose || null;
    const companyId = String(notes.companyId || '');
    const planIdInput = Number(notes.planId);
    const billingCycle = notes.billingCycle || 'monthly';

    if (event.event !== 'payment.captured') {
      const expectedAmountPaise = notes.purpose === 'trial_activation' && billingCycle === 'trial' && planIdInput === 3
        ? 100
        : notes.purpose === 'plan_purchase' && [2, 3].includes(planIdInput)
          ? getPricePaise(planIdInput, billingCycle)
          : null;
      if (!companyId || expectedAmountPaise == null || String(entity.order_id) !== String(order.id) ||
          Number(entity.amount) !== Number(expectedAmountPaise) || Number(order.amount) !== Number(expectedAmountPaise) ||
          entity.currency !== 'INR' || order.currency !== 'INR' ||
          (notes.purpose === 'trial_activation' && !paymentMatchesOrder({ order, payment: { ...entity, status: 'captured' }, companyId, purpose: 'trial_activation', planId: 3, billingCycle: 'trial', expectedAmountPaise: 100 })) ||
          (notes.purpose === 'plan_purchase' && !paymentMatchesOrder({ order, payment: { ...entity, status: 'captured' }, companyId, purpose: 'plan_purchase', planId: planIdInput, billingCycle, expectedAmountPaise }))) {
        return res.status(400).send('Payment attempt does not match a configured company plan order');
      }
      const attemptClient = await pool.connect();
      try {
        await attemptClient.query('BEGIN');
        await attemptClient.query("SELECT pg_advisory_xact_lock(hashtext('sub_payment_' || $1))", [String(paymentId)]);
        await recordPendingSubscriptionPayment(attemptClient, {
          companyId, purpose: notes.purpose, planId: planIdInput, billingCycle,
          order, amountPaise: expectedAmountPaise, currency: 'INR'
        });
        await recordSubscriptionPaymentAttempt(attemptClient, {
          companyId, orderId, paymentId, status: event.event === 'payment.failed' ? 'failed' : 'authorized',
          amountPaise: expectedAmountPaise, currency: 'INR',
          providerPayload: { event: event.event, orderId, paymentId, status: entity.status, errorCode: entity.error_code || null }
        });
        await attemptClient.query('COMMIT');
        return res.json({ status: 'ok', message: `Payment ${event.event.split('.')[1]} attempt recorded; no subscription access granted.` });
      } catch (error) {
        await attemptClient.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        attemptClient.release();
      }
    }

    if (notes.purpose === 'trial_activation') {
      if (!companyId || !paymentMatchesOrder({ order, payment: entity, companyId, purpose: 'trial_activation', planId: 3, billingCycle: 'trial', expectedAmountPaise: 100 })) {
        return res.status(400).send('Trial payment does not match the expected order');
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('trial_payment_' || $1))", [String(paymentId)]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext('trial_company_' || $1))", [companyId]);
        const duplicate = await client.query("SELECT company_id FROM subscription_events WHERE metadata->>'razorpay_payment_id' = $1 LIMIT 1", [paymentId]);
        if (duplicate.rows.length) {
          await client.query('ROLLBACK');
          if (String(duplicate.rows[0].company_id) !== companyId) return res.status(403).send('Payment belongs to another company');
          return res.json({ status: 'ok', message: 'Trial payment already processed' });
        }
        const company = await client.query('SELECT id, plan_id, trial_started_at, is_on_trial FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
        if (!company.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).send('Company not found');
        }
        if (company.rows[0].trial_started_at || company.rows[0].is_on_trial) {
          await client.query('ROLLBACK');
          return res.json({ status: 'ok', message: 'Company is not eligible for another trial' });
        }
        await recordCapturedSubscriptionPayment(client, {
          companyId, purpose: 'trial_activation', planId: 3, billingCycle: 'trial',
          orderId, paymentId, amountPaise: 100, currency: 'INR', providerStatus: entity.status,
          providerPayload: { orderId, paymentId, status: entity.status, captured: entity.captured, source: 'webhook' }
        });
        await client.query(
          `UPDATE companies SET plan_id = 3, subscription_status = 'trial', is_on_trial = TRUE,
           trial_started_at = NOW(), trial_ends_at = NOW() + INTERVAL '30 days',
           subscription_expires_at = NOW() + INTERVAL '30 days', updated_at = NOW() WHERE id = $1`, [companyId]
        );
        const metadata = JSON.stringify({ razorpay_payment_id: paymentId, razorpay_order_id: orderId, amount_paise: 100, currency: 'INR', duration_days: 30, verified: true, source: 'webhook' });
        await client.query(`INSERT INTO subscription_events (company_id, event_type, old_plan_id, new_plan_id, metadata, created_at) VALUES ($1, 'trial_payment_verified', 1, 3, $2, NOW())`, [companyId, metadata]);
        await client.query(`INSERT INTO subscription_events (company_id, event_type, old_plan_id, new_plan_id, metadata, created_at) VALUES ($1, 'trial_started', 1, 3, $2, NOW())`, [companyId, metadata]);
        await client.query('COMMIT');
        invalidatePlanCache(companyId);
        return res.json({ status: 'ok', message: 'Trial activated' });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    // Trial payments never enter the paid plan purchase path.
    if (notes.purpose !== 'plan_purchase') return res.json({ status: 'ignored' });

    if (!companyId || isNaN(planIdInput)) {
      console.error('❌ [Razorpay Webhook] Missing companyId or planId in notes', notes);
      return res.status(400).send('Missing metadata in notes');
    }

    const planId = planIdInput;
    const expectedAmountPaise = getPricePaise(planId, billingCycle);
    if (![2, 3].includes(planId) || expectedAmountPaise == null || !paymentMatchesOrder({
      order, payment: entity, companyId, purpose: 'plan_purchase', planId, billingCycle, expectedAmountPaise
    })) {
      console.error('[Razorpay Webhook] Captured payment does not match a configured company plan order.');
      return res.status(400).send('Payment does not match expected plan order');
    }

    console.log(`[Razorpay Webhook] Processing capture | Company ID: ${companyId} | Plan ID: ${planId} | Payment ID: ${paymentId}`);

    const dbClient = await pool.connect();

    try {
      await dbClient.query('BEGIN');

      await dbClient.query("SELECT pg_advisory_xact_lock(hashtext('sub_payment_' || $1))", [String(paymentId)]);
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

      await recordCapturedSubscriptionPayment(dbClient, {
        companyId, purpose: 'plan_purchase', planId, billingCycle,
        orderId, paymentId, amountPaise: expectedAmountPaise, currency: 'INR',
        providerStatus: entity.status,
        providerPayload: { orderId, paymentId, status: entity.status, captured: entity.captured, source: 'webhook' }
      });

      // Update Company Plan & Subscription Expiry Dates
      await dbClient.query(
        `UPDATE companies 
         SET plan_id = $1, 
             subscription_status = 'active', 
             is_on_trial = FALSE, 
             subscription_expires_at = (CASE WHEN is_on_trial THEN NOW() WHEN subscription_expires_at > NOW() THEN subscription_expires_at ELSE NOW() END) + (CASE WHEN $2 = 'yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END),
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
      const planName = getPlan(planId)?.name || 'Enterprise';
      const companyInfo = await pool.query(
        `SELECT c.company_name, c.subscription_expires_at, u.name as owner_name, u.email as owner_email
         FROM companies c
         LEFT JOIN users u ON u.company_id = c.id AND u.role = 'owner'
         WHERE c.id = $1
         LIMIT 1`,
        [companyId]
      );
      if (companyInfo.rows.length > 0) {
        const info = companyInfo.rows[0];
        const ownerEmail = info.owner_email;
        if (ownerEmail) {
          const ownerName = info.owner_name || 'Owner';
          const invoiceNumber = `INV-SUB-${new Date().getFullYear()}-${String(companyId).padStart(4, '0')}-${Date.now().toString().slice(-4)}`;
          const paidAmount = getPlan(planId)[billingCycle === 'yearly' ? 'priceYearly' : 'priceMonthly'];

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

    if (err.code === 'SUBSCRIPTION_PAYMENT_IDENTITY_CONFLICT' || err.code === 'SUBSCRIPTION_PAYMENT_ORDER_CONFLICT') {
      return res.status(403).send('Payment is already associated with another subscription order');
    }

    // Trial retries must never fall into the paid-plan worker path.
    if (verifiedOrderPurpose === 'trial_activation') return res.status(500).send('Trial activation will be retried by the payment provider');

    // Enqueue background retry job with BullMQ (3 attempts with exponential backoff)
    try {
      const { enqueueWebhookRetry } = require('../utils/queue');
      const event = req.body || {};
      const entity = event.payload?.payment?.entity || {};
      // Prefer notes from the provider-fetched order. Payment webhook notes are
      // not sufficient authority to choose a company or subscription plan.
      const notes = verifiedOrderNotes || {};
      const companyId = String(notes.companyId || '');
      const planId = Number(notes.planId) || null;

      await enqueueWebhookRetry({
        companyId,
        planId,
        billingCycle: notes.billingCycle || 'monthly',
        paymentId: entity.id || null,
        orderId: entity.order_id || null,
        purpose: notes.purpose || verifiedOrderPurpose || null,
        error: err.message
      });

      if (companyId && notes.purpose === 'plan_purchase' && [2, 3].includes(planId)) {
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
