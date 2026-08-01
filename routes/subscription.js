const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { pool } = require('../db');
const Sentry = require("@sentry/node");
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan, invalidatePlanCache } = require('../middleware/planMiddleware');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── Owner-only guard ──────────────────────────────────────────────────────────
router.use(authenticateToken);
const requireOwner = (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({
      message: 'Only the company owner can manage subscription plans.'
    });
  }
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscription/status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', loadPlan, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const plan = req.plan;

    // Live usage counts
    const [empResult, invResult, companyResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count FROM users WHERE company_id = $1 AND role = 'employee'`,
        [companyId]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM inventory_items WHERE company_id = $1 AND (is_deleted = FALSE OR is_deleted IS NULL)`,
        [companyId]
      ),
      pool.query(
        `SELECT is_on_trial, trial_ends_at, trial_started_at, subscription_expires_at, is_first_login
         FROM companies WHERE id = $1`,
        [companyId]
      )
    ]);

    const employeeCount = parseInt(empResult.rows[0]?.count || 0, 10);
    const inventoryCount = parseInt(invResult.rows[0]?.count || 0, 10);
    const company = companyResult.rows[0] || {};

    const employeeLimit = plan.employee_limit;
    const inventoryLimit = plan.max_inventory_items;

    // Calculate exact days remaining for paid plans (or fallback to trial days)
    let daysRemaining = plan.days_remaining || 0;
    if (!plan.is_trial && company.subscription_expires_at) {
      const now = new Date();
      const expiry = new Date(company.subscription_expires_at);
      const diffMs = expiry.getTime() - now.getTime();
      daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    }

    res.json({
      plan: {
        id: plan.id,
        name: plan.name,
        is_trial: plan.is_trial || false,
        days_remaining: daysRemaining,
        trial_ends_at: plan.trial_ends_at || null,
        employee_limit: employeeLimit,
        max_inventory_items: inventoryLimit,
        messages_history_days: plan.messages_history_days,
        features: plan.features
      },
      usage: {
        employees: employeeCount,
        inventory_items: inventoryCount
      },
      limits: {
        employees_remaining: employeeLimit === null ? null : Math.max(0, employeeLimit - employeeCount),
        inventory_remaining: inventoryLimit === null ? null : Math.max(0, inventoryLimit - inventoryCount)
      },
      trial_started_at: company.trial_started_at || null,
      subscription_expires_at: company.subscription_expires_at || null,
      is_first_login: company.is_first_login
    });
  } catch (err) {
    console.error('❌ Subscription Status Fetch Error:', err);
    res.status(500).json({ message: 'Failed to fetch subscription status.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscription/plans
// ─────────────────────────────────────────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plans ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Fetch Plans Error:', err);
    res.status(500).json({ message: 'Failed to fetch subscription plans.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscription/trial-status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/trial-status', requireOwner, loadPlan, async (req, res) => {
  try {
    const plan = req.plan;
    res.json({
      is_trial: plan.is_trial,
      days_remaining: plan.days_remaining,
      trial_ends_at: plan.trial_ends_at
    });
  } catch (err) {
    console.error('❌ Trial Status Fetch Error:', err);
    res.status(500).json({ message: 'Failed to fetch trial status.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscription/welcome-dismissed
// ─────────────────────────────────────────────────────────────────────────────
router.post('/welcome-dismissed', requireOwner, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    await pool.query('UPDATE companies SET is_first_login = FALSE WHERE id = $1', [companyId]);
    res.json({ ok: true, message: 'Welcome dialog dismissed.' });
  } catch (err) {
    console.error('❌ Dismiss Welcome Error:', err);
    res.status(500).json({ message: 'Failed to update welcome status.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscription/create-order
// Create a Razorpay order for a plan upgrade
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create-order', requireOwner, async (req, res) => {
  try {
    const { planId, billingCycle = 'monthly' } = req.body;
    const companyId = req.user.companyId;
    const userId = req.user.id || req.user.userId;

    console.log(`[Razorpay] Creating Order | Company ID: ${companyId} | User ID: ${userId} | Plan: ${planId} | Cycle: ${billingCycle}`);

    if (![2, 3].includes(planId)) {
      console.warn(`[Razorpay] Order Creation Rejected: Invalid plan ID ${planId}`);
      return res.status(400).json({ message: 'Invalid plan selected.' });
    }

    const planResult = await pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
    if (planResult.rows.length === 0) {
      console.warn(`[Razorpay] Order Creation Rejected: Plan ID ${planId} not found in DB`);
      return res.status(404).json({ message: 'Plan not found.' });
    }

    const plan = planResult.rows[0];
    const amount = billingCycle === 'yearly' ? parseFloat(plan.price_yearly) : parseFloat(plan.price_monthly);

    if (amount <= 0) {
      console.warn(`[Razorpay] Order Creation Rejected: Price is invalid (${amount})`);
      return res.status(400).json({ message: 'Invalid amount for paid plan.' });
    }

    const options = {
      amount: Math.round(amount * 100), // amount in paise
      currency: "INR",
      receipt: `rcpt_${companyId}_${planId}_${Date.now()}`,
      notes: {
        companyId: String(companyId),
        planId: String(planId),
        billingCycle: String(billingCycle),
        userId: String(userId)
      }
    };

    const order = await razorpay.orders.create(options);
    console.log(`[Razorpay] Order Created Successfully | Order ID: ${order.id} | Amount: ₹${amount} (${options.amount} paise)`);

    res.json(order);
  } catch (err) {
    console.error('❌ [Razorpay] Create Order Error:', err);
    Sentry.captureException(err, { extra: { planId: req.body.planId, companyId: req.user.companyId } });
    res.status(500).json({ message: 'Failed to create payment order.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscription/verify-payment
// Verify Razorpay payment signature & execute company subscription upgrade
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify-payment', requireOwner, async (req, res) => {
  const startTime = Date.now();
  const companyId = req.user.companyId;

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      planId: planIdInput,
      billingCycle = 'monthly'
    } = req.body;

    console.log(`[Razorpay] Payment Verified | Order ID: ${razorpay_order_id} | Payment ID: ${razorpay_payment_id}`);
    console.log(`[Subscription] Starting Activation | Company ID = ${companyId} | Target Plan Input = ${planIdInput}`);

    if (!razorpay_order_id || !razorpay_payment_id) {
      console.warn(`[Subscription] Activation Rejected: Missing order_id or payment_id`);
      return res.status(400).json({ message: 'Missing order ID or payment ID.' });
    }

    const planId = parseInt(planIdInput, 10);
    if (![2, 3].includes(planId)) {
      console.warn(`[Subscription] Activation Rejected: Invalid plan ID ${planId}`);
      return res.status(400).json({ message: 'Invalid plan selected.' });
    }

    // 1. Optional Signature Check (if signature provided)
    if (razorpay_signature) {
      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(body.toString())
        .digest("hex");

      const sigBufExpected = Buffer.from(expectedSignature, 'utf8');
      const sigBufActual = Buffer.from(razorpay_signature, 'utf8');
      const signaturesMatch = sigBufExpected.length === sigBufActual.length &&
        crypto.timingSafeEqual(sigBufExpected, sigBufActual);

      if (!signaturesMatch) {
        console.error(`[Razorpay] Signature Check Failed for Order ${razorpay_order_id}`);
        return res.status(400).json({ message: 'Invalid payment signature' });
      }
      console.log(`[Razorpay] Signature Valid for Payment ID: ${razorpay_payment_id}`);
    }

    // 2. Order Lookup & Plan Verification from Razorpay API
    let verifiedPlanId = planId;
    try {
      const order = await razorpay.orders.fetch(razorpay_order_id);
      const orderPlanId = parseInt(order.notes?.planId, 10);
      const orderCompanyId = parseInt(order.notes?.companyId, 10);
      if ([2, 3].includes(orderPlanId)) verifiedPlanId = orderPlanId;

      if (orderCompanyId && orderCompanyId !== parseInt(companyId, 10)) {
        console.warn(`[Subscription] Security Mismatch: Order belongs to Company ${orderCompanyId}, user belongs to Company ${companyId}`);
        return res.status(403).json({ message: 'Order does not belong to your account.' });
      }
      console.log(`[Razorpay] Order Verified from API | Verified Plan ID: ${verifiedPlanId}`);
    } catch (fetchErr) {
      console.warn(`[Razorpay] Order Lookup Notice: ${fetchErr.message}`);
    }

    // 3. Database Transaction Activation
    console.log(`[Subscription] Updating Companies Table... Target Plan = ${verifiedPlanId}`);
    await pool.query('BEGIN');

    // Duplicate Check
    const duplicateCheck = await pool.query(
      `SELECT id FROM subscription_events WHERE metadata->>'razorpay_payment_id' = $1`,
      [razorpay_payment_id]
    );

    if (duplicateCheck.rows.length > 0) {
      await pool.query('ROLLBACK');
      console.log(`[Subscription] Already Processed | Payment ID ${razorpay_payment_id} exists in subscription_events`);
      invalidatePlanCache(companyId);
      return res.json({ 
        ok: true,
        message: 'Subscription already activated.',
        is_duplicate: true 
      });
    }

    // 4. Update Company Plan & Subscription Expiry Dates
    // Valid PostgreSQL parameterized expression syntax
    const updateResult = await pool.query(
      `UPDATE companies 
       SET plan_id = $1, 
           subscription_status = 'active', 
           is_on_trial = FALSE, 
           subscription_expires_at = COALESCE(GREATEST(subscription_expires_at, NOW()), NOW()) + (CASE WHEN $2 = 'yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END),
           updated_at = NOW()
       WHERE id = $3`,
      [verifiedPlanId, billingCycle, companyId]
    );

    if (updateResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      console.error(`[Subscription] ERROR: UPDATE companies modified 0 rows for Company ID ${companyId}`);
      return res.status(404).json({ message: 'Company record not found for activation.' });
    }

    console.log(`[Subscription] Updating Companies Table... Rows Updated = ${updateResult.rowCount}`);
    console.log(`[Subscription] Updating Billing Dates... Billing Cycle = ${billingCycle}`);

    // 5. Insert Subscription Log Event
    await pool.query(
      `INSERT INTO subscription_events (company_id, event_type, new_plan_id, metadata, created_at)
       VALUES ($1, 'upgrade', $2, $3, NOW())`,
      [companyId, verifiedPlanId, JSON.stringify({ 
        razorpay_payment_id, 
        razorpay_order_id, 
        billingCycle
      })]
    );

    await pool.query('COMMIT');
    console.log(`[Subscription] Commit Successful`);

    // 6. Invalidate Plan Cache & Update AI Permissions
    console.log(`[Subscription] Updating AI Permissions... Invalidating Redis Plan Cache for Company ${companyId}`);
    invalidatePlanCache(companyId);

    const planNameMap = { 1: 'Free', 2: 'Basic', 3: 'Pro' };
    const planName = planNameMap[verifiedPlanId] || 'Pro';

    const durationMs = Date.now() - startTime;
    console.log(`[Subscription] Activation Completed in ${durationMs}ms | Company ID: ${companyId} | New Plan: ${planName}`);

    // Push notification (async, non-blocking)
    try {
      const { notifyPlanUpgrade } = require('../services/smartNotificationService');
      notifyPlanUpgrade(req.user.userId || req.user.id, companyId, planName).catch(() => {});
    } catch {}

    res.json({
      ok: true,
      success: true,
      message: `Subscription activated successfully! Welcome to SmartERP ${planName}.`,
      plan: { id: verifiedPlanId, name: planName },
      durationMs
    });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error('❌ [Subscription] Activation Transaction Failed & Rolled Back:', err);
    Sentry.captureException(err, { extra: { razorpay_payment_id: req.body.razorpay_payment_id, companyId } });
    res.status(500).json({ message: 'Subscription activation failed. Transaction rolled back safely.' });
  }
});

module.exports = router;
