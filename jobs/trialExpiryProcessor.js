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
// Main processor function
// ─────────────────────────────────────────────────────────────────────────────
async function processTrialExpiry() {
  console.log('⏰ [Trial Expiry Processor] Starting...');
  const startTime = Date.now();
  let warningsSent = 0;
  let downgraded = 0;

  try {
    // ── 1. Send warning notifications (7, 3, 1 days before expiry) ───────────
    for (const days of [7, 3, 1]) {
      try {
        const rows = await pool.query(
          `SELECT c.id, c.owner_id, c.company_name
           FROM companies c
           WHERE c.is_on_trial = TRUE
             AND c.trial_ends_at BETWEEN
               NOW() + ($1 * INTERVAL '1 day') - INTERVAL '1 hour'
               AND
               NOW() + ($1 * INTERVAL '1 day') + INTERVAL '1 hour'`,
          [days]
        );

        for (const company of rows.rows) {
          await sendTrialWarning(company, days);
          warningsSent++;
        }
      } catch (err) {
        console.error(`❌ Error processing ${days}-day warnings:`, err.message);
      }
    }

    // ── 2. Downgrade expired trials ──────────────────────────────────────────
    const expired = await pool.query(
      `UPDATE companies
       SET plan_id             = 1,
           is_on_trial         = FALSE,
           subscription_status = 'active'
       WHERE is_on_trial = TRUE
         AND trial_ends_at <= NOW()
       RETURNING id, owner_id, company_name`
    );

    for (const company of expired.rows) {
      console.log(`📉 Trial expired and downgraded to Free: "${company.company_name}"`);

      // Log the event
      await logSubscriptionEvent({
        company_id: company.id,
        event_type: 'trial_expired',
        old_plan_id: 3,
        new_plan_id: 1,
        metadata: { downgraded_at: new Date().toISOString() }
      });

      // Invalidate cache so next request loads Free plan
      invalidatePlanCache(company.id);

      // Send expiry notification to owner
      if (company.owner_id) {
        await createNotification({
          user_id: company.owner_id,
          company_id: company.id,
          type: 'trial_expired',
          title: '🔔 Your Pro Trial Has Ended',
          message: 'Your 30-day Pro trial has expired. You are now on the Free plan. Upgrade anytime to restore all Pro features.',
          priority: 'high',
          data: { upgrade_url: '/billing' }
        }).catch(e => console.error('❌ Trial expiry notification error:', e.message));
      }

      downgraded++;
    }

    console.log(`✅ [Trial Expiry Processor] Done in ${Date.now() - startTime}ms | Warnings: ${warningsSent} | Downgraded: ${downgraded}`);
  } catch (err) {
    console.error('❌ [Trial Expiry Processor] Fatal error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Start the cron job
// ─────────────────────────────────────────────────────────────────────────────
function startTrialExpiryProcessor() {
  // Run daily at 9:00 AM IST = 3:30 AM UTC
  cron.schedule('30 3 * * *', processTrialExpiry, {
    scheduled: true,
    timezone: 'Asia/Kolkata'
  });
  console.log('✅ Trial expiry processor scheduled (daily 9:00 AM IST)');
}

module.exports = { startTrialExpiryProcessor, processTrialExpiry, logSubscriptionEvent };
