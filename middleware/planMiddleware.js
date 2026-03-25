/**
 * planMiddleware.js
 * Loads the company's active subscription plan and attaches it to req.plan.
 *
 * Key behaviours:
 *  - FAIL-CLOSED: If the DB query fails, the request is rejected with 500 (no accidental unlock).
 *  - CACHE: Plans are cached per company for 5 minutes to reduce DB load.
 *  - TRIAL DETECTION: If the trial is active, req.plan reflects Pro features even if plan_id is different.
 *  - NO DB MUTATION: Middleware never writes to the DB. Expiry downgrades happen only in the cron job.
 */

const NodeCache = require('node-cache');
const { pool } = require('../db');

// 5-minute TTL cache — auto-expires so plan changes propagate within 5 min
const planCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

async function loadPlan(req, res, next) {
  try {
    const companyId = req.user?.companyId;

    // No company linked (e.g. super admin or edge case) — skip gracefully
    if (!companyId) return next();

    // ── Check in-memory cache ──────────────────────────────────────────────
    const cacheKey = `plan:${companyId}`;
    const cached = planCache.get(cacheKey);
    if (cached) {
      req.plan = cached;
      return next();
    }

    // ── Query DB: company + plan ───────────────────────────────────────────
    const result = await pool.query(
      `SELECT
         c.plan_id,
         c.is_on_trial,
         c.trial_ends_at,
         p.id         AS plan_db_id,
         p.name,
         p.employee_limit,
         p.max_inventory_items,
         p.max_material_requests,
         p.messages_history_days,
         p.features,
         c.subscription_expires_at
       FROM companies c
       JOIN plans p ON c.plan_id = p.id
       WHERE c.id = $1`,
      [companyId]
    );

    if (result.rows.length === 0) {
      // Company or plan missing — fail closed
      return res.status(500).json({
        message: 'Unable to verify subscription plan. Please try again later.'
      });
    }

    const data = result.rows[0];
    const now = new Date();
    const trialEnds = data.trial_ends_at ? new Date(data.trial_ends_at) : null;
    const trialActive = data.is_on_trial && trialEnds && trialEnds > now;

    // Real-time Expiry Check for Paid Plans
    const subscriptionExpires = data.subscription_expires_at ? new Date(data.subscription_expires_at) : null;
    const isActuallyExpired = !data.is_on_trial && subscriptionExpires && subscriptionExpires <= now;

    let planObj;

    if (isActuallyExpired) {
      // ── EXPIRED PAID PLAN: instantly force Free features ──
      const freeResult = await pool.query(
        `SELECT id, name, employee_limit, max_inventory_items, max_material_requests, messages_history_days, features
         FROM plans WHERE id = 1`
      );
      const free = freeResult.rows[0];
      planObj = {
        ...free,
        is_trial: false,
        days_remaining: 0,
        trial_ends_at: data.trial_ends_at
      };
    } else if (trialActive) {
      // ── TRIAL ACTIVE: serve Pro features regardless of stored plan_id ──
      const proResult = await pool.query(
        `SELECT id, name, employee_limit, max_inventory_items, max_material_requests, messages_history_days, features
         FROM plans WHERE id = 3`
      );
      const pro = proResult.rows[0];
      planObj = {
        ...pro,
        is_trial: true,
        days_remaining: Math.ceil((trialEnds - now) / (1000 * 60 * 60 * 24)),
        trial_ends_at: data.trial_ends_at
      };
    } else {
      // ── REGULAR / EXPIRED TRIAL: serve the actual stored plan ─────────
      // Note: if trial expired, the cron job will downgrade plan_id;
      // middleware just reads what's there (fail-safe read-only).
      planObj = {
        id: data.plan_db_id,
        name: data.name,
        employee_limit: data.employee_limit,
        max_inventory_items: data.max_inventory_items,
        max_material_requests: data.max_material_requests,
        messages_history_days: data.messages_history_days,
        features: data.features,
        is_trial: false,
        days_remaining: 0,
        trial_ends_at: data.trial_ends_at
      };
    }

    // Store in cache and attach to request
    planCache.set(cacheKey, planObj);
    req.plan = planObj;
    next();
  } catch (err) {
    console.error('❌ planMiddleware error:', err.message);
    // FAIL-CLOSED: never allow access if plan check fails
    return res.status(500).json({
      message: 'Unable to verify subscription plan. Please try again later.'
    });
  }
}

/**
 * Invalidate a company's plan cache entry (call after plan upgrades).
 * @param {string|number} companyId
 */
function invalidatePlanCache(companyId) {
  planCache.del(`plan:${companyId}`);
}

module.exports = { loadPlan, invalidatePlanCache };
