/**
 * jobs/trialExpiryProcessor.js
 *
 * Daily cron job scheduled at 9:00 AM IST (3:30 AM UTC).
 * This is the ONLY place that mutates plan_id for expired trials.
 * Middleware is read-only; this job owns all downgrade logic.
 *
 * Responsibilities:
 *   1. Send 7-day, 3-day, and 1-day expiry warning notifications to owners
 *   2. Downgrade expired trials to Free plan
 *   3. Log every change to subscription_events table
 *   4. Invalidate plan cache after downgrade
 */

const cron = require('node-cron');
const { pool } = require('../db');
const { createNotification } = require('../utils/notificationHelpers');
const { invalidatePlanCache } = require('../middleware/planMiddleware');

// ─────────────────────────────────────────────────────────────────────────────
// Helper: log to subscription_events
// ─────────────────────────────────────────────────────────────────────────────
async function logSubscriptionEvent({ company_id, event_type, old_plan_id, new_plan_id, metadata = {} }) {
  try {
    await pool.query(
      `INSERT INTO subscription_events (company_id, event_type, old_plan_id, new_plan_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [company_id, event_type, old_plan_id || null, new_plan_id || null, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('❌ Failed to log subscription event:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: send a trial warning notification to the company owner
// ─────────────────────────────────────────────────────────────────────────────
async function sendTrialWarning(company, daysLeft) {
  if (!company.owner_id) return;

  const titles = {
    7: `⏳ Pro Trial Expiring in 7 Days`,
    3: `⏳ Pro Trial Expiring in 3 Days`,
    1: `🔴 Pro Trial Ends Tomorrow!`
  };

  const messages = {
    7: `Your SmartERP Pro trial ends in 7 days. Upgrade now to continue using AI, Payroll, Location Tracking, and all Pro features.`,
    3: `Your trial ends in 3 days. Upgrade to keep payroll, location tracking, advanced reports and more.`,
    1: `Your 30-day Pro trial ends tomorrow. Upgrade now to avoid losing access to premium features.`
  };

  try {
    await createNotification({
      user_id: company.owner_id,
      company_id: company.id,
      type: 'trial_expiring',
      title: titles[daysLeft],
      message: messages[daysLeft],
      priority: daysLeft === 1 ? 'high' : 'medium',
      data: { days_remaining: daysLeft, upgrade_url: '/billing' }
    });
    console.log(`✅ Sent ${daysLeft}-day trial warning to owner of "${company.company_name}"`);
  } catch (err) {
    console.error(`❌ Failed to send ${daysLeft}-day warning:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: send a subscription expiry warning
// ─────────────────────────────────────────────────────────────────────────────
async function sendSubscriptionWarning(company, daysLeft) {
  if (!company.owner_id) return;

  const titles = {
    7: `⏳ Subscription Expiring in 7 Days`,
    3: `⏳ Subscription Expiring in 3 Days`,
    1: `🔴 Subscription Ends Tomorrow!`
  };

  const messages = {
    7: `Your SmartERP subscription will expire in 7 days. Renew now to avoid any interruption in service.`,
    3: `Your subscription expires in 3 days. Please renew your plan to keep your team active.`,
    1: `Your subscription ends tomorrow. Renew today to keep using all your premium features.`
  };

  try {
    await createNotification({
      user_id: company.owner_id,
      company_id: company.id,
      type: 'subscription_expiring',
      title: titles[daysLeft],
      message: messages[daysLeft],
      priority: daysLeft === 1 ? 'high' : 'medium',
      data: { days_remaining: daysLeft, upgrade_url: '/owner/billing' }
    });
  } catch (err) {
    console.error(`❌ Failed to send subscription warning:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main processor function
// ─────────────────────────────────────────────────────────────────────────────
async function processSubscriptionLifecycle() {
  console.log('⏰ [Subscription Processor] Starting...');
  const startTime = Date.now();
  let warningsSent = 0;
  let downgraded = 0;

  try {
    // ── 1. TRIAL WARNINGS (7, 3, 1 days) ───────────────────────────────────
    for (const days of [7, 3, 1]) {
      const rows = await pool.query(
        `SELECT id, owner_id, company_name FROM companies 
         WHERE is_on_trial = TRUE 
         AND trial_ends_at BETWEEN NOW() + ($1 * INTERVAL '1 day') - INTERVAL '1 hour' AND NOW() + ($1 * INTERVAL '1 day') + INTERVAL '1 hour'`,
        [days]
      );
      for (const company of rows.rows) {
        await sendTrialWarning(company, days);
        warningsSent++;
      }
    }

    // ── 2. PAID SUBSCRIPTION WARNINGS (7, 3, 1 days) ────────────────────────
    for (const days of [7, 3, 1]) {
      const rows = await pool.query(
        `SELECT id, owner_id, company_name FROM companies 
         WHERE is_on_trial = FALSE AND plan_id > 1 
         AND subscription_expires_at BETWEEN NOW() + ($1 * INTERVAL '1 day') - INTERVAL '1 hour' AND NOW() + ($1 * INTERVAL '1 day') + INTERVAL '1 hour'`,
        [days]
      );
      for (const company of rows.rows) {
        await sendSubscriptionWarning(company, days);
        warningsSent++;
      }
    }

    // ── 3. EXPIRED TRIALS ──────────────────────────────────────────────────
    const expiredTrials = await pool.query(
      `UPDATE companies SET plan_id = 1, is_on_trial = FALSE, subscription_status = 'active'
       WHERE is_on_trial = TRUE AND trial_ends_at <= NOW()
       RETURNING id, owner_id, company_name`
    );

    for (const company of expiredTrials.rows) {
      await logSubscriptionEvent({
        company_id: company.id,
        event_type: 'trial_expired',
        old_plan_id: 3,
        new_plan_id: 1,
        metadata: { downgraded_at: new Date().toISOString() }
      });
      invalidatePlanCache(company.id);
      if (company.owner_id) {
        await createNotification({
          user_id: company.owner_id,
          company_id: company.id,
          type: 'trial_expired',
          title: '🔔 Your Pro Trial Has Ended',
          message: 'Your 30-day Pro trial has expired. You are now on the Free plan. Upgrade anytime to restore all Pro features.',
          priority: 'high',
          data: { upgrade_url: '/owner/billing' }
        }).catch(e => {});
      }
      downgraded++;
    }

    // ── 4. EXPIRED PAID SUBSCRIPTIONS ───────────────────────────────────────
    // We check plan_id > 1 to avoid re-downgrading Free users
    const expiredPaid = await pool.query(
      `UPDATE companies SET plan_id = 1, subscription_status = 'expired'
       WHERE is_on_trial = FALSE AND plan_id > 1 AND subscription_expires_at <= NOW()
       RETURNING id, owner_id, company_name`
    );

    for (const company of expiredPaid.rows) {
      console.log(`📉 Subscription expired for "${company.company_name}" - Downgraded to Free`);
      await logSubscriptionEvent({
        company_id: company.id,
        event_type: 'subscription_expired',
        old_plan_id: null, // We don't have the old plan ID easily here but we know it was > 1
        new_plan_id: 1,
        metadata: { downgraded_at: new Date().toISOString() }
      });
      invalidatePlanCache(company.id);
      if (company.owner_id) {
        await createNotification({
          user_id: company.owner_id,
          company_id: company.id,
          type: 'subscription_expired',
          title: '⚠️ Subscription Expired',
          message: 'Your SmartERP subscription has expired. Your account has been moved to the Free plan. Renew now to restore full access.',
          priority: 'high',
          data: { upgrade_url: '/owner/billing' }
        }).catch(e => {});
      }
      downgraded++;
    }

    console.log(`✅ [Subscription Processor] Done in ${Date.now() - startTime}ms | Warnings: ${warningsSent} | Downgraded: ${downgraded}`);
  } catch (err) {
    console.error('❌ [Subscription Processor] Fatal error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Start the cron job
// ─────────────────────────────────────────────────────────────────────────────
function startTrialExpiryProcessor() {
  // Run daily at 9:00 AM IST = 3:30 AM UTC
  cron.schedule('30 3 * * *', processSubscriptionLifecycle, {
    scheduled: true,
    timezone: 'Asia/Kolkata'
  });
  console.log('✅ Subscription lifecycle processor scheduled (daily 9:00 AM IST)');
}

module.exports = { startTrialExpiryProcessor, processSubscriptionLifecycle, logSubscriptionEvent };
