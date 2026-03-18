const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const Sentry = require("@sentry/node");
const { notifyPlanUpgrade } = require('../services/smartNotificationService');
const { invalidatePlanCache } = require('../middleware/planMiddleware');

router.post('/razorpay', async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    
    if (!signature) {
      console.warn('⚠️ Razorpay Webhook: Missing signature');
      return res.status(400).send('No signature');
    }

    if (!secret) {
      console.error('❌ Razorpay Webhook: RAZORPAY_WEBHOOK_SECRET is not set');
      return res.status(500).send('Webhook secret not configured');
    }

    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('hex');

    if (expectedSignature !== signature) {
      console.error('❌ Razorpay Webhook: Invalid signature match');
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
    const userId = notes.userId;

    if (!companyId || isNaN(planIdInput)) {
      console.error('❌ Razorpay Webhook: Missing companyId or planId in notes', notes);
      return res.status(400).send('Missing metadata in notes');
    }

    // Mapping: Test Plan (ID 4) -> Basic (ID 2)
    const planId = planIdInput === 4 ? 2 : planIdInput;
    const expiryInterval = billingCycle === 'yearly' ? '1 year' : '1 month';

    console.log(`📡 Razorpay Webhook: Processing capture for Company ${companyId}, Plan ${planId}`);

    await pool.query('BEGIN');

    // ── Duplicate Check ─────────────────────────────
    const duplicateCheck = await pool.query(
      `SELECT id FROM subscription_events WHERE metadata->>'razorpay_payment_id' = $1`,
      [paymentId]
    );

    if (duplicateCheck.rows.length > 0) {
      await pool.query('ROLLBACK');
      console.log('ℹ️ Webhook: Already processed payment', paymentId);
      return res.json({ status: 'ok', message: 'Already processed' });
    }

    // Update Company
    await pool.query(
      `UPDATE companies 
       SET plan_id = $1, 
           subscription_status = 'active', 
           is_on_trial = FALSE, 
           subscription_expires_at = COALESCE(GREATEST(subscription_expires_at, NOW()), NOW()) + INTERVAL $2,
           updated_at = NOW()
       WHERE id = $3`,
      [planId, expiryInterval, companyId]
    );

    // Log Event
    await pool.query(
      `INSERT INTO subscription_events (company_id, event_type, new_plan_id, metadata, created_at)
       VALUES ($1, 'upgrade', $2, $3, NOW())`,
      [companyId, planId, JSON.stringify({ 
        razorpay_payment_id: paymentId, 
        razorpay_order_id: orderId, 
        billingCycle,
        source: 'webhook',
        purchased_test_plan: planIdInput === 4
      })]
    );

    await pool.query('COMMIT');

    // 📣 Notify & Cache Invalidation
    invalidatePlanCache(companyId);
    
    if (userId) {
      const planNameMap = { 1: 'Free', 2: 'Basic', 3: 'Pro', 4: 'Basic (Test)' };
      const planName = planNameMap[planId] || 'Basic';
      notifyPlanUpgrade(userId, companyId, planName).catch(e => console.error('Push Error Webhook:', e.message));
    }

    res.json({ status: 'success' });
  } catch (err) {
    console.error('❌ Razorpay Webhook Error:', err);
    Sentry.captureException(err);
    res.status(500).send('Internal Server Error');
  }
});

module.exports = router;
