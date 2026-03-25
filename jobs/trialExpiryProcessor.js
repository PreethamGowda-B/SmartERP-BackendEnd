/**
 * jobs/trialExpiryProcessor.js
 *
 * Daily cron job scheduled at 9:00 AM IST (3:30 AM UTC).
 * This is the ONLY place that mutates plan_id for expired trials.
 * Middleware is read-only; this job owns all downgrade logic.
 *
 * Responsibilities:
 *   1. Send 7-day, 3-day, and 1-day expiry warning notifications to owners (In-App + Email)
 *   2. Downgrade expired trials and subscriptions to Free plan
 *   3. Send 0-day (Expired) notifications on downgrade
 *   4. Log every change to subscription_events table
 *   5. Invalidate plan cache after downgrade
 *   6. Ensure Idempotency using subscription_notification_logs
 */

const cron = require('node-cron');
const { pool } = require('../db');
const { createNotification } = require('../utils/notificationHelpers');
const { invalidatePlanCache } = require('../middleware/planMiddleware');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

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
// Helper: Check Idempotency Logs
// ─────────────────────────────────────────────────────────────────────────────
async function hasBeenNotified(companyId, type, stage) {
  try {
    const res = await pool.query(
      `SELECT id FROM subscription_notification_logs WHERE company_id = $1 AND notification_type = $2 AND stage = $3`,
      [companyId, type, stage]
    );
    return res.rows.length > 0;
  } catch (e) {
    console.error('Idempotency check failed:', e);
    return false; // Safest fallback is false, but could risk dupes if DB is briefly down
  }
}

async function markNotified(companyId, type, stage) {
  try {
    await pool.query(
      `INSERT INTO subscription_notification_logs (company_id, notification_type, stage) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [companyId, type, stage]
    );
  } catch (e) {
    console.error('Idempotency mark failed:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Send Emails via Resend
// ─────────────────────────────────────────────────────────────────────────────
async function sendExpiryEmail(email, subject, bodyContent, planName) {
  if (!email || !process.env.RESEND_API_KEY) return;
  const frontendUrl = process.env.FRONTEND_ORIGIN || "https://smart-erp-front-end.vercel.app";
  
  try {
    await resend.emails.send({
      from: "SmartERP <noreply@prozync.in>",
      to: email,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f8fafc; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="background: #4F46E5; display: inline-block; padding: 12px 20px; border-radius: 8px;">
              <span style="color: white; font-size: 20px; font-weight: bold;">SmartERP</span>
            </div>
          </div>
          <h2 style="color: #1e293b; text-align: center; margin-bottom: 8px;">Subscription Update</h2>
          <p style="color: #64748b; text-align: center; margin-bottom: 32px;">${bodyContent}</p>
          <div style="background: white; border: 2px solid #e2e8f0; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
            <div style="font-size: 18px; font-weight: bold; color: #1e293b;">Plan: <span style="color: #4F46E5;">${planName}</span></div>
          </div>
          <div style="text-align: center;">
            <a href="${frontendUrl}/owner/billing" style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Manage Subscription</a>
          </div>
        </div>
      `,
    });
  } catch (e) {
    console.error("Failed to send Resend email:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logic Processors
// ─────────────────────────────────────────────────────────────────────────────
async function handleWarning(company, daysLeft, type) {
  if (!company.owner_id) return;
  
  const alreadySent = await hasBeenNotified(company.id, type, daysLeft);
  if (alreadySent) return; // Already emailed them about this stage!

  const isTrial = type === 'trial';
  let title = `⏳ ${isTrial ? 'Pro Trial' : 'Subscription'} Expiring in ${daysLeft} Days`;
  if (daysLeft === 1) title = `🔴 ${isTrial ? 'Pro Trial' : 'Subscription'} Ends Tomorrow!`;
  
  let message = `Your ${isTrial ? 'SmartERP Pro trial' : 'subscription'} ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Renew now to avoid losing access to premium features.`;
  
  // 1. Send In-App Notification
  try {
    await createNotification({
      user_id: company.owner_id,
      company_id: company.id,
      type: isTrial ? 'trial_expiring' : 'subscription_expiring',
      title: title,
      message: message,
      priority: daysLeft === 1 ? 'high' : 'medium',
      data: { days_remaining: daysLeft, upgrade_url: '/owner/billing' }
    });
  } catch (err) {
    console.error(`❌ Failed to send ${daysLeft}-day warning app-notif:`, err.message);
  }

  // 2. Send Email
  if (company.owner_email) {
    const subject = `Your SmartERP ${isTrial ? 'Trial' : 'Subscription'} is Expiring Soon`;
    await sendExpiryEmail(company.owner_email, subject, message, isTrial ? 'Pro (Trial)' : 'Premium');
  }

  // 3. Mark as sent
  await markNotified(company.id, type, daysLeft);
  console.log(`✅ Sent ${daysLeft}-day ${type} warning to ${company.company_name}`);
}

async function processSubscriptionLifecycle() {
  console.log('⏰ [Subscription Processor] Starting...');
  const startTime = Date.now();
  let warningsSent = 0;
  let downgraded = 0;

  try {
    const nowMs = Date.now();

    // ── 1. WARNINGS FOR ACTIVE ──────────────────────────────────────────────
    const activeCompanies = await pool.query(
      `SELECT c.id, c.owner_id, c.company_name, c.is_on_trial,
              c.trial_ends_at, c.subscription_expires_at, u.email as owner_email
       FROM companies c
       LEFT JOIN users u ON c.owner_id = u.id
       WHERE (c.is_on_trial = TRUE AND c.trial_ends_at > NOW())
          OR (c.is_on_trial = FALSE AND c.plan_id > 1 AND c.subscription_expires_at > NOW())`
    );

    for (const company of activeCompanies.rows) {
      const type = company.is_on_trial ? 'trial' : 'paid';
      const expiry = company.is_on_trial ? new Date(company.trial_ends_at) : new Date(company.subscription_expires_at);
      
      const diffMs = expiry.getTime() - nowMs;
      const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24)); // Round up to nearest day

      if ([7, 3, 1].includes(daysLeft)) {
        await handleWarning(company, daysLeft, type);
        warningsSent++;
      }
    }

    // ── 2. EXPIRED TRIALS ──────────────────────────────────────────────────
    const expiredTrials = await pool.query(
      `UPDATE companies SET plan_id = 1, is_on_trial = FALSE, subscription_status = 'active'
       WHERE is_on_trial = TRUE AND trial_ends_at <= NOW()
       RETURNING id, owner_id, company_name`
    );

    for (const company of expiredTrials.rows) {
      const alreadySent = await hasBeenNotified(company.id, 'trial', 0);
      if (!alreadySent) {
        if (company.owner_id) {
          // Send owner email
          const ownerRes = await pool.query('SELECT email FROM users WHERE id = $1', [company.owner_id]);
          const email = ownerRes.rows[0]?.email;
          if (email) {
            await sendExpiryEmail(
              email, 
              'Your SmartERP Pro Trial Has Ended', 
              'Your 30-day Pro trial has expired. You have been downgraded to the Free plan. Renew now to restore all premium features.', 
              'Free (Downgraded)'
            );
          }
          // App notif
          await createNotification({
            user_id: company.owner_id,
            company_id: company.id,
            type: 'trial_expired',
            title: '🔔 Your Pro Trial Has Ended',
            message: 'Your 30-day Pro trial has expired. You are now on the Free plan. Upgrade anytime.',
            priority: 'high',
            data: { upgrade_url: '/owner/billing' }
          }).catch(e => {});
        }
        await markNotified(company.id, 'trial', 0);
      }

      await logSubscriptionEvent({
        company_id: company.id,
        event_type: 'trial_expired',
        old_plan_id: 3,
        new_plan_id: 1,
        metadata: { downgraded_at: new Date().toISOString() }
      });
      invalidatePlanCache(company.id);
      downgraded++;
    }

    // ── 3. EXPIRED PAID SUBSCRIPTIONS ───────────────────────────────────────
    const expiredPaid = await pool.query(
      `UPDATE companies SET plan_id = 1, subscription_status = 'expired'
       WHERE is_on_trial = FALSE AND plan_id > 1 AND subscription_expires_at <= NOW()
       RETURNING id, owner_id, company_name`
    );

    for (const company of expiredPaid.rows) {
      const alreadySent = await hasBeenNotified(company.id, 'paid', 0);
      if (!alreadySent) {
        if (company.owner_id) {
          const ownerRes = await pool.query('SELECT email FROM users WHERE id = $1', [company.owner_id]);
          const email = ownerRes.rows[0]?.email;
          if (email) {
            await sendExpiryEmail(
              email, 
              'Your SmartERP Subscription Has Expired', 
              'Your paid subscription has ended. You have been moved to the Free plan. Renew your subscription immediately to avoid data access interruptions.', 
              'Free (Expired)'
            );
          }
          await createNotification({
            user_id: company.owner_id,
            company_id: company.id,
            type: 'subscription_expired',
            title: '⚠️ Subscription Expired',
            message: 'Your SmartERP subscription has expired. You are now on the Free plan. Renew now to restore full access.',
            priority: 'high',
            data: { upgrade_url: '/owner/billing' }
          }).catch(e => {});
        }
        await markNotified(company.id, 'paid', 0);
      }

      console.log(`📉 Subscription expired for "${company.company_name}" - Downgraded to Free`);
      await logSubscriptionEvent({
        company_id: company.id,
        event_type: 'subscription_expired',
        old_plan_id: null,
        new_plan_id: 1,
        metadata: { downgraded_at: new Date().toISOString() }
      });
      invalidatePlanCache(company.id);
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
