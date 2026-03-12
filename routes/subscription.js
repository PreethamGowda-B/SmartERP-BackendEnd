/**
 * routes/subscription.js
 * Owner-only endpoints for subscription status, trial info, and upgrade flow.
 *
 * Endpoints:
 *   GET  /api/subscription/status           — Current plan + live usage counts
 *   GET  /api/subscription/trial-status     — Trial banner data
 *   POST /api/subscription/welcome-dismissed — Mark is_first_login = false
 *   POST /api/subscription/upgrade          — Stub (payment gateway TBD)
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');

// ── Owner-only guard ──────────────────────────────────────────────────────────
router.use(authenticateToken);
router.use((req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({
      message: 'Only the company owner can manage subscription plans.'
    });
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscription/status
// Returns plan details + live usage counts + trial info
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

    const employeeCount = parseInt(empResult.rows[0].count, 10);
    const inventoryCount = parseInt(invResult.rows[0].count, 10);
    const company = companyResult.rows[0];

    const employeeLimit = plan.employee_limit;
    const inventoryLimit = plan.max_inventory_items;

    res.json({
      plan: {
        id: plan.id,
        name: plan.name,
        is_trial: plan.is_trial || false,
        days_remaining: plan.days_remaining || 0,
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
    console.error('GET /subscription/status error:', err.message);
    res.status(500).json({ message: 'Server error fetching subscription status.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscription/trial-status
// Trial banner data for the dashboard
// ─────────────────────────────────────────────────────────────────────────────
router.get('/trial-status', loadPlan, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const plan = req.plan;

    const companyResult = await pool.query(
      `SELECT is_on_trial, trial_ends_at, trial_started_at, plan_id FROM companies WHERE id = $1`,
      [companyId]
    );
    const company = companyResult.rows[0];

    const isTrialActive = plan.is_trial === true;
    const daysRemaining = plan.days_remaining || 0;
    const trialEndsAt = company.trial_ends_at;

    let bannerMessage = null;
    if (isTrialActive && daysRemaining > 0) {
      bannerMessage = `Pro Trial — ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''} remaining. Upgrade now to continue using all Pro features.`;
    }

    res.json({
      is_trial: isTrialActive,
      days_remaining: daysRemaining,
      trial_started_at: company.trial_started_at,
      trial_ends_at: trialEndsAt,
      current_plan: isTrialActive ? 'Pro (Trial)' : plan.name,
      downgrade_to: isTrialActive ? 'Free' : null,
      banner_message: bannerMessage
    });
  } catch (err) {
    console.error('GET /subscription/trial-status error:', err.message);
    res.status(500).json({ message: 'Server error fetching trial status.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscription/welcome-dismissed
// Called once after the owner closes the trial welcome modal
// ─────────────────────────────────────────────────────────────────────────────
router.post('/welcome-dismissed', async (req, res) => {
  try {
    const companyId = req.user.companyId;
    await pool.query(
      `UPDATE companies SET is_first_login = FALSE WHERE id = $1`,
      [companyId]
    );
    res.json({ ok: true, message: 'Welcome modal will not show again.' });
  } catch (err) {
    console.error('POST /subscription/welcome-dismissed error:', err.message);
    res.status(500).json({ message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscription/upgrade
// Stub endpoint — payment gateway integration TBD (Razorpay / Stripe)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upgrade', (req, res) => {
  res.json({
    message: 'To upgrade your plan, please contact support at support@prozync.in or visit our billing page.',
    contact_email: 'support@prozync.in',
    billing_url: '/billing'
  });
});

module.exports = router;
