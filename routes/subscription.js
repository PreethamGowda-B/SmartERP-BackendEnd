const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { pool } = require('../db');
const Sentry = require("@sentry/node");
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan, invalidatePlanCache } = require('../middleware/planMiddleware');
const { SUBSCRIPTION_PLANS, getPlan, getPricePaise, isRazorpayConfigured, verifyCheckoutSignature, paymentMatchesOrder } = require('../services/subscriptionCatalog');

function getRazorpay() {
  if (!isRazorpayConfigured()) return null;
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

// Public plan catalog. Values and stable names are served from the canonical catalog.
router.get('/plans', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, features, employee_limit, max_inventory_items, max_material_requests, messages_history_days FROM plans WHERE id = ANY($1::int[]) ORDER BY id ASC', [[1, 2, 3]]);
    const byId = new Map(result.rows.map((row) => [Number(row.id), row]));
    if ([1, 2, 3].some((id) => !byId.has(id))) return res.status(503).json({ message: 'Subscription plan catalog is not fully configured.' });
    return res.json(Object.entries(SUBSCRIPTION_PLANS).map(([id, plan]) => ({
      ...byId.get(Number(id)), id: Number(id), plan_key: plan.key, name: plan.name,
      price_monthly: plan.priceMonthly, price_yearly: plan.priceYearly, employee_limit: plan.employeeLimit
    })));
  } catch (err) {
    console.error('❌ Fetch Plans Error:', err.message);
    return res.status(503).json({ message: 'Subscription plan catalog is unavailable.' });
  }
});

// ── Authenticated subscription routes ────────────────────────────────────────
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
    const companyId = req.user?.companyId;

    // Super admin or users with no company — return unlimited sentinel plan
    if (!companyId) {
      return res.json({
        plan: {
          id: 0, name: 'Super Admin', is_trial: false, days_remaining: 36500,
          trial_ends_at: null, employee_limit: null, max_inventory_items: null,
          messages_history_days: 9999,
          features: {
            payroll: true, messages: true, ai_assistant: true,
            basic_reports: true, export_reports: true, advanced_reports: true,
            inventory_images: true, priority_support: true, location_tracking: true
          }
        },
        usage: { employees: 0, inventory_items: 0 },
        limits: { employees_remaining: null, inventory_remaining: null },
        trial_started_at: null, subscription_expires_at: null, is_first_login: false
      });
    }

    const plan = req.plan;

    // Defensive: plan middleware should always set this, but guard anyway
    if (!plan) {
      console.error('❌ subscription/status: req.plan is undefined after loadPlan for companyId:', companyId);
      return res.status(503).json({ message: 'Subscription plan data unavailable. Please contact support.' });
    }

    // Live usage counts
    const [empResult, invResult, companyResult, subEventResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count FROM users WHERE company_id = $1 AND role = 'employee'`,
        [companyId]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM inventory_items WHERE company_id = $1 AND (is_deleted = FALSE OR is_deleted IS NULL)`,
        [companyId]
      ),
      pool.query(
        `SELECT is_on_trial, trial_ends_at, trial_started_at, subscription_expires_at, is_first_login, billing_cycle, subscription_status
         FROM companies WHERE id = $1`,
        [companyId]
      ).catch(async () => {
        // Fallback if billing_cycle column doesn't exist yet on companies
        return pool.query(
          `SELECT is_on_trial, trial_ends_at, trial_started_at, subscription_expires_at, is_first_login, subscription_status
           FROM companies WHERE id = $1`,
          [companyId]
        );
      }),
      pool.query(
        `SELECT metadata FROM subscription_events WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [companyId]
      ).catch(() => ({ rows: [] }))
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
    } else if (!plan.is_trial && (company.subscription_status === 'active' || plan.id >= 2)) {
      daysRemaining = 365;
    }

    // Determine accurate billing cycle (yearly vs monthly)
    let effectiveBillingCycle = company.billing_cycle;
    if (!effectiveBillingCycle && subEventResult.rows.length > 0) {
      const meta = subEventResult.rows[0]?.metadata || {};
      effectiveBillingCycle = meta.billingCycle || meta.billing_cycle;
    }
    if (!effectiveBillingCycle) {
      effectiveBillingCycle = daysRemaining > 45 ? 'yearly' : 'monthly';
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
      billing_cycle: effectiveBillingCycle,
      trial_started_at: company.trial_started_at || null,
      subscription_expires_at: company.subscription_expires_at || null,
      subscription_status: company.subscription_status || (plan.is_trial ? 'trial' : 'active'),
      is_first_login: company.is_first_login,
      trial_eligible: Number(plan.id) === 1 && !company.trial_started_at && !company.is_on_trial
    });
  } catch (err) {
    console.error('❌ Subscription Status Fetch Error:', err);
    res.status(500).json({ message: 'Failed to fetch subscription status.' });
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

// A trial is activated only after Razorpay confirms a captured ₹1 payment.
router.post('/trial/create-order', requireOwner, async (req, res) => {
  const razorpay = getRazorpay();
  if (!razorpay) return res.status(503).json({ message: 'Trial payment is not configured.' });
  const companyId = req.user.companyId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const company = await client.query('SELECT id, plan_id, trial_started_at, is_on_trial FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    if (!company.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Company not found.' });
    }
    const priorTrial = await client.query(
      "SELECT id FROM subscription_events WHERE company_id = $1 AND event_type IN ('trial_started', 'trial_payment_verified') LIMIT 1",
      [companyId]
    );
    if (company.rows[0].trial_started_at || company.rows[0].is_on_trial || priorTrial.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This company has already used its trial.' });
    }

    const pendingOrder = await client.query(
      `SELECT metadata->>'razorpay_order_id' AS order_id FROM subscription_events
       WHERE company_id = $1 AND event_type = 'trial_payment_order_created'
       ORDER BY created_at DESC LIMIT 1`, [companyId]
    );
    if (pendingOrder.rows[0]?.order_id) {
      let existingOrder;
      try { existingOrder = await razorpay.orders.fetch(pendingOrder.rows[0].order_id); }
      catch (error) {
        await client.query('ROLLBACK');
        console.error('[Trial] Existing order status could not be confirmed:', error.message);
        return res.status(502).json({ message: 'Could not safely confirm the previous trial payment order. Please contact support.' });
      }
      await client.query('ROLLBACK');
      if (existingOrder.status === 'paid') return res.status(409).json({ message: 'A trial payment is already paid and awaiting activation. Refresh subscription status before retrying.' });
      return res.json({ id: existingOrder.id, amount: existingOrder.amount, currency: existingOrder.currency, key: process.env.RAZORPAY_KEY_ID });
    }

    const order = await razorpay.orders.create({
      amount: 100, currency: 'INR', receipt: `trial_${String(companyId).slice(-12)}_${Date.now()}`,
      notes: { companyId: String(companyId), purpose: 'trial_activation', planId: '3', billingCycle: 'trial', userId: String(req.user.id || req.user.userId) }
    });
    await client.query(
      `INSERT INTO subscription_events (company_id, event_type, new_plan_id, metadata, created_at)
       VALUES ($1, 'trial_payment_order_created', 3, $2, NOW())`,
      [companyId, JSON.stringify({ razorpay_order_id: order.id, amount_paise: 100, currency: 'INR' })]
    );
    await client.query('COMMIT');
    return res.json({ id: order.id, amount: order.amount, currency: order.currency, key: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Trial] Failed to create payment order:', err.message);
    return res.status(502).json({ message: 'Could not create the trial payment order.' });
  } finally {
    client.release();
  }
});

router.post('/trial/verify-payment', requireOwner, async (req, res) => {
  const razorpay = getRazorpay();
  if (!razorpay) return res.status(503).json({ message: 'Trial payment is not configured.' });
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  const companyId = req.user.companyId;
  if (!verifyCheckoutSignature({ orderId, paymentId, signature, secret: process.env.RAZORPAY_KEY_SECRET })) {
    return res.status(400).json({ message: 'Invalid payment signature.' });
  }

  let order;
  let payment;
  try {
    [order, payment] = await Promise.all([razorpay.orders.fetch(orderId), razorpay.payments.fetch(paymentId)]);
  } catch (err) {
    console.error('[Trial] Payment provider verification unavailable:', err.message);
    return res.status(502).json({ message: 'Payment could not be verified with the provider. Please retry later.' });
  }
  if (!paymentMatchesOrder({ order, payment, companyId, purpose: 'trial_activation', planId: 3, billingCycle: 'trial', expectedAmountPaise: 100 })) {
    return res.status(400).json({ message: 'A captured ₹1 trial payment for this company could not be verified.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('trial_payment_' || $1))", [String(paymentId)]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('trial_company_' || $1))", [String(companyId)]);
    const duplicate = await client.query("SELECT company_id FROM subscription_events WHERE metadata->>'razorpay_payment_id' = $1 LIMIT 1", [paymentId]);
    if (duplicate.rows.length) {
      await client.query('ROLLBACK');
      if (String(duplicate.rows[0].company_id) !== String(companyId)) return res.status(403).json({ message: 'Payment belongs to another company.' });
      invalidatePlanCache(companyId);
      return res.json({ ok: true, success: true, is_duplicate: true, message: 'Trial payment was already applied.' });
    }
    const company = await client.query('SELECT id, plan_id, trial_started_at, is_on_trial FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    if (!company.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Company not found.' });
    }
    if (company.rows[0].trial_started_at || company.rows[0].is_on_trial) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This company has already used its trial.' });
    }
    await client.query(
      `UPDATE companies SET plan_id = 3, subscription_status = 'trial', is_on_trial = TRUE,
       trial_started_at = NOW(), trial_ends_at = NOW() + INTERVAL '30 days',
       subscription_expires_at = NOW() + INTERVAL '30 days', updated_at = NOW() WHERE id = $1`,
      [companyId]
    );
    const metadata = JSON.stringify({ razorpay_payment_id: paymentId, razorpay_order_id: orderId, amount_paise: 100, currency: 'INR', duration_days: 30, verified: true });
    await client.query(
      `INSERT INTO subscription_events (company_id, event_type, old_plan_id, new_plan_id, metadata, created_at)
       VALUES ($1, 'trial_payment_verified', 1, 3, $2, NOW())`, [companyId, metadata]
    );
    await client.query(
      `INSERT INTO subscription_events (company_id, event_type, old_plan_id, new_plan_id, metadata, created_at)
       VALUES ($1, 'trial_started', 1, 3, $2, NOW())`, [companyId, metadata]
    );
    await client.query('COMMIT');
    invalidatePlanCache(companyId);
    return res.json({ ok: true, success: true, plan: { id: 3, name: getPlan(3).name, is_trial: true }, trial_days: 30 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Trial] Activation transaction failed:', err.message);
    return res.status(500).json({ message: 'Trial activation could not be completed.' });
  } finally {
    client.release();
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

    const razorpay = getRazorpay();
    if (!razorpay) return res.status(503).json({ message: 'Paid checkout is not configured.' });

    console.log(`[Razorpay] Creating Order | Company ID: ${companyId} | User ID: ${userId} | Plan: ${planId} | Cycle: ${billingCycle}`);

    const catalogPlan = getPlan(planId);
    if (![2, 3].includes(Number(planId)) || !catalogPlan || !['monthly', 'yearly'].includes(billingCycle)) {
      console.warn(`[Razorpay] Order Creation Rejected: Invalid plan ID ${planId}`);
      return res.status(400).json({ message: 'Invalid plan selected.' });
    }

    const planResult = await pool.query('SELECT id FROM plans WHERE id = $1', [Number(planId)]);
    if (planResult.rows.length === 0) {
      console.warn(`[Razorpay] Order Creation Rejected: Plan ID ${planId} not found in DB`);
      return res.status(404).json({ message: 'Plan not found.' });
    }

    const amountPaise = getPricePaise(planId, billingCycle);
    const amount = amountPaise / 100;

    if (amount <= 0) {
      console.warn(`[Razorpay] Order Creation Rejected: Price is invalid (${amount})`);
      return res.status(400).json({ message: 'Invalid amount for paid plan.' });
    }

    const options = {
      amount: amountPaise,
      currency: "INR",
      receipt: `sub_${crypto.randomBytes(16).toString('hex')}`,
      notes: {
        companyId: String(companyId),
        planId: String(planId),
        purpose: 'plan_purchase',
        billingCycle: String(billingCycle),
        userId: String(userId)
      }
    };

    const order = await razorpay.orders.create(options);
    console.log(`[Razorpay] Order Created Successfully | Order ID: ${order.id} | Amount: ₹${amount} (${options.amount} paise)`);

    res.json({ ...order, key: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('❌ [Razorpay] Create Order Error:', err);
    Sentry.captureException(err, { extra: { planId: req.body.planId, companyId: req.user.companyId } });
    res.status(500).json({ message: 'Failed to create payment order.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscription/verify-payment
// Highly Concurrent, Idempotent, Row-Locked Subscription Activation
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

    const razorpay = getRazorpay();
    if (!razorpay) return res.status(503).json({ message: 'Paid checkout is not configured.' });

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      console.warn(`[Subscription] Activation Rejected: Missing order_id, payment_id, or signature`);
      return res.status(400).json({ message: 'Missing order ID, payment ID, or signature.' });
    }

    const planId = parseInt(planIdInput, 10);
    if (![2, 3].includes(planId) || !['monthly', 'yearly'].includes(billingCycle)) {
      console.warn(`[Subscription] Activation Rejected: Invalid plan ID ${planId}`);
      return res.status(400).json({ message: 'Invalid plan selected.' });
    }

    // 1. Mandatory Signature Check (Timing-safe HMAC SHA-256)
    const signaturesMatch = verifyCheckoutSignature({ orderId: razorpay_order_id, paymentId: razorpay_payment_id, signature: razorpay_signature, secret: process.env.RAZORPAY_KEY_SECRET });
    if (!signaturesMatch) {
      return res.status(400).json({ message: 'Invalid payment signature' });
    }

    // Verify the order and captured payment with Razorpay. A valid checkout signature alone
    // does not prove that the amount, currency, company, plan, or capture status is correct.
    let order;
    let payment;
    try {
      [order, payment] = await Promise.all([razorpay.orders.fetch(razorpay_order_id), razorpay.payments.fetch(razorpay_payment_id)]);
    } catch (fetchErr) {
      console.error('[Subscription] Payment provider verification unavailable:', fetchErr.message);
      return res.status(502).json({ message: 'Payment could not be verified with the provider. Please retry later.' });
    }
    if (String(order.id) !== String(razorpay_order_id)) return res.status(400).json({ message: 'Payment order does not match.' });
    if (String(order.notes?.companyId) !== String(companyId)) return res.status(403).json({ message: 'Order does not belong to your account.' });
    if (Number(order.notes?.planId) !== planId || order.notes?.billingCycle !== billingCycle || order.notes?.purpose !== 'plan_purchase') {
      return res.status(400).json({ message: 'Payment order does not match the selected plan.' });
    }
    const verifiedPlanId = planId;
    if (!paymentMatchesOrder({ order, payment, companyId, purpose: 'plan_purchase', planId, billingCycle, expectedAmountPaise: getPricePaise(planId, billingCycle) })) {
      return res.status(400).json({ message: 'Payment is not captured for the expected plan amount.' });
    }

    // 3. Transaction Isolation & Row-Level Lock on dedicated connection client
    console.log(`[Concurrency] Acquiring Dedicated Client, Transaction Advisory Lock & Row Lock for Company ${companyId}...`);
    const dbClient = await pool.connect();

    try {
      await dbClient.query('BEGIN');

      await dbClient.query("SELECT pg_advisory_xact_lock(hashtext('sub_payment_' || $1))", [String(razorpay_payment_id)]);
      // Advisory lock per company ID ensures strict serial execution per company
      await dbClient.query(`SELECT pg_advisory_xact_lock(hashtext('sub_upgrade_' || $1))`, [String(companyId)]);

      // Row-level lock on companies table
      const compCheck = await dbClient.query(
        `SELECT id, plan_id, subscription_status FROM companies WHERE id = $1 FOR UPDATE`,
        [companyId]
      );

      if (compCheck.rows.length === 0) {
        await dbClient.query('ROLLBACK');
        console.error(`[Subscription] ERROR: Company ID ${companyId} not found in DB`);
        return res.status(404).json({ message: 'Company record not found for activation.' });
      }

      const currentPlanId = compCheck.rows[0].plan_id;
      console.log(`[Subscription] Company ID = ${companyId} | Current Plan = ${currentPlanId}`);

      // Duplicate Check
      const duplicateCheck = await dbClient.query(
        `SELECT company_id FROM subscription_events WHERE metadata->>'razorpay_payment_id' = $1 LIMIT 1`,
        [razorpay_payment_id]
      );

      if (duplicateCheck.rows.length > 0) {
        await dbClient.query('ROLLBACK');
        if (String(duplicateCheck.rows[0].company_id) !== String(companyId)) {
          return res.status(403).json({ message: 'Payment belongs to another company.' });
        }
        invalidatePlanCache(companyId);
        return res.json({ 
          ok: true,
          success: true,
          message: 'Subscription already activated.',
          is_duplicate: true 
        });
      }

      // 4. Update Company Plan & Subscription Expiry Dates
      console.log(`[Subscription] Updating Companies Table... Target Plan = ${verifiedPlanId}`);
      const updateResult = await dbClient.query(
        `UPDATE companies 
         SET plan_id = $1, 
             subscription_status = 'active', 
             is_on_trial = FALSE, 
             subscription_expires_at = (CASE WHEN is_on_trial THEN NOW() WHEN subscription_expires_at > NOW() THEN subscription_expires_at ELSE NOW() END) + (CASE WHEN $2 = 'yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END),
             updated_at = NOW()
         WHERE id = $3`,
        [verifiedPlanId, billingCycle, companyId]
      );

      console.log(`[Subscription] Updating Companies Table... Rows Updated = ${updateResult.rowCount}`);
      console.log(`[Subscription] Updating Billing Dates... Billing Cycle = ${billingCycle}`);

      // 5. Insert Subscription Log Event
      await dbClient.query(
        `INSERT INTO subscription_events (company_id, event_type, new_plan_id, metadata, created_at)
         VALUES ($1, 'upgrade', $2, $3, NOW())`,
        [companyId, verifiedPlanId, JSON.stringify({ 
          razorpay_payment_id, 
          razorpay_order_id, 
          billingCycle
        })]
      );

      await dbClient.query('COMMIT');
      console.log(`[Subscription] Commit Successful`);
    } catch (txErr) {
      await dbClient.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      dbClient.release();
    }

    // 6. Invalidate Plan Cache & Update AI Permissions
    console.log(`[Subscription] Updating AI Permissions... Invalidating Redis Plan Cache for Company ${companyId}`);
    invalidatePlanCache(companyId);

    const planName = getPlan(verifiedPlanId).name;

    const durationMs = Date.now() - startTime;
    // 7. Generate Invoice & Email Owner
    try {
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
        const ownerEmail = info.owner_email || req.user.email;
        const ownerName = info.owner_name || req.user.name || 'Owner';
        const invoiceNumber = `INV-SUB-${new Date().getFullYear()}-${String(companyId).padStart(4, '0')}-${Date.now().toString().slice(-4)}`;
        const paidAmount = billingCycle === 'yearly' ? getPlan(verifiedPlanId).priceYearly : getPlan(verifiedPlanId).priceMonthly;

        const { sendSubscriptionInvoiceEmail } = require('../services/emailNotificationService');
        sendSubscriptionInvoiceEmail({
          ownerEmail,
          ownerName,
          companyName: info.company_name,
          planName,
          billingCycle,
          amount: paidAmount,
          invoiceNumber,
          paymentId: razorpay_payment_id,
          orderId: razorpay_order_id,
          expiryDate: info.subscription_expires_at
        }).catch(e => console.error('Error sending invoice email:', e.message));
      }
    } catch (invErr) {
      console.error('⚠️ [Subscription] Failed to generate/send invoice email:', invErr.message);
    }

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
