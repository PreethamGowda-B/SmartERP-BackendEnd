/**
 * planMiddleware.js
 * Centralized subscription plan loader and atomic limit enforcement middleware.
 */

const { pool } = require('../db');
const { redisClient } = require('../utils/redis');
const { getPlan, getPlanLimit, isUnlimitedPlan, getEmployeeLimit, resolvePlanTier } = require('../services/subscriptionCatalog');
const { consumeAIRequest } = require('../services/aiQuota');
const NodeCache = require('node-cache');

const PLAN_CACHE_TTL = 300; // 5 minutes in seconds
const memPlanCache = new NodeCache({ stdTTL: 60, checkperiod: 120, maxKeys: 1000 });

async function loadPlan(req, res, next) {
  try {
    const companyId = req.user?.companyId || req.user?.company_id || req.customer?.companyId || req.customer?.company_id || req.proofCaller?.companyId || req.proofCaller?.company_id;
    if (!companyId) {
      if (req.user?.role === 'super_admin') {
        req.plan = {
          id: 0,
          plan_key: 'super_admin',
          name: 'Super Admin',
          employee_limit: null,
          max_inventory_items: null,
          features: {
            payroll: true, messages: true, ai_assistant: true,
            basic_reports: true, export_reports: true, advanced_reports: true,
            inventory_images: true, priority_support: true, location_tracking: true
          },
          is_trial: false,
          days_remaining: 36500,
          trial_ends_at: null,
          subscription_expires_at: null
        };
      }
      return next();
    }

    const cacheKey = `plan:${companyId}`;

    // 1. Fast L1 in-memory cache check (0ms, shields database even if Redis is absent)
    const memCached = memPlanCache.get(cacheKey);
    if (memCached) {
      const nowMs = Date.now();
      const trialExpiryMs = memCached.is_trial && memCached.trial_ends_at ? new Date(memCached.trial_ends_at).getTime() : null;
      const paidExpiryMs = !memCached.is_trial && memCached.subscription_expires_at ? new Date(memCached.subscription_expires_at).getTime() : null;
      if ((trialExpiryMs === null || trialExpiryMs > nowMs) && (paidExpiryMs === null || paidExpiryMs > nowMs)) {
        req.plan = memCached;
        return next();
      }
      memPlanCache.del(cacheKey);
    }

    // 2. Distributed Redis cache check
    if (redisClient && redisClient.status === 'ready') {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          const cachedPlan = JSON.parse(cached);
          const nowMs = Date.now();
          const trialExpiryMs = cachedPlan.is_trial && cachedPlan.trial_ends_at ? new Date(cachedPlan.trial_ends_at).getTime() : null;
          const paidExpiryMs = !cachedPlan.is_trial && cachedPlan.subscription_expires_at ? new Date(cachedPlan.subscription_expires_at).getTime() : null;
          if ((trialExpiryMs === null || trialExpiryMs > nowMs) && (paidExpiryMs === null || paidExpiryMs > nowMs)) {
            memPlanCache.set(cacheKey, cachedPlan, 60);
            req.plan = cachedPlan;
            return next();
          }
          await redisClient.del(cacheKey);
        }
      } catch (redisErr) {
        console.warn('⚠️ Redis plan cache read error:', redisErr.message);
      }
    }

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
         p.max_active_jobs,
         p.max_storage_bytes,
         p.features,
         c.subscription_expires_at
       FROM companies c
       JOIN plans p ON c.plan_id = p.id
       WHERE c.id = $1`,
      [companyId]
    );

    if (result.rows.length === 0) {
      // Graceful fallback: company has no valid plan (null plan_id or bad JOIN).
      // Default to Free plan so users can still access the app with limited features.
      console.warn(`⚠️ planMiddleware: No plan found for company ${companyId}. Falling back to Free plan.`);
      try {
        const freeResult = await pool.query(
          `SELECT id, name, employee_limit, max_inventory_items, max_material_requests, messages_history_days, max_active_jobs, max_storage_bytes, features FROM plans WHERE id = 1`
        );
        if (freeResult.rows.length > 0) {
          const starter = getPlan(1);
          req.plan = { ...freeResult.rows[0], plan_key: starter.key, name: starter.name, employee_limit: starter.employeeLimit, is_trial: false, days_remaining: 0, trial_ends_at: null };
          return next();
        }
      } catch (fallbackErr) {
        console.error('❌ planMiddleware: Free plan fallback also failed:', fallbackErr.message);
      }
      return res.status(503).json({
        message: 'Subscription plan data unavailable. Please contact support.'
      });
    }

    const data = result.rows[0];
    if (!getPlan(data.plan_db_id)) {
      return res.status(503).json({ message: 'Subscription plan data is invalid. Please contact support.' });
    }
    const now = new Date();
    const trialEnds = data.trial_ends_at ? new Date(data.trial_ends_at) : null;
    const trialActive = data.is_on_trial && trialEnds && trialEnds > now;

    const subscriptionExpires = data.subscription_expires_at ? new Date(data.subscription_expires_at) : null;
    const isActuallyExpired = (data.is_on_trial && (!trialEnds || trialEnds <= now)) || (!data.is_on_trial && subscriptionExpires && subscriptionExpires <= now);

    let planObj;

    if (isActuallyExpired) {
      const freeResult = await pool.query(
        `SELECT id, name, employee_limit, max_inventory_items, max_material_requests, messages_history_days, max_active_jobs, max_storage_bytes, features
         FROM plans WHERE id = 1`
      );
      const free = freeResult.rows[0];
      planObj = {
        ...free,
        is_trial: false,
        days_remaining: 0,
        trial_ends_at: data.trial_ends_at,
        subscription_expires_at: data.subscription_expires_at
      };
    } else if (trialActive) {
      const proResult = await pool.query(
        `SELECT id, name, employee_limit, max_inventory_items, max_material_requests, messages_history_days, max_active_jobs, max_storage_bytes, features
         FROM plans WHERE id = 3`
      );
      const pro = proResult.rows[0];
      planObj = {
        ...pro,
        is_trial: true,
        days_remaining: Math.ceil((trialEnds - now) / (1000 * 60 * 60 * 24)),
        trial_ends_at: data.trial_ends_at,
        subscription_expires_at: data.subscription_expires_at
      };
    } else {
      let daysRemaining = 0;
      if (subscriptionExpires) {
        daysRemaining = Math.max(0, Math.ceil((subscriptionExpires - now) / (1000 * 60 * 60 * 24)));
      } else if (data.plan_db_id >= 2) {
        daysRemaining = 365;
      }
      planObj = {
        id: data.plan_db_id,
        name: data.name,
        employee_limit: data.employee_limit,
        max_inventory_items: data.max_inventory_items,
        max_material_requests: data.max_material_requests,
        messages_history_days: data.messages_history_days,
        max_active_jobs: data.max_active_jobs,
        max_storage_bytes: data.max_storage_bytes,
        features: data.features,
        is_trial: false,
        days_remaining: daysRemaining,
        trial_ends_at: data.trial_ends_at,
        subscription_expires_at: data.subscription_expires_at
      };
    }

    const canonicalPlan = getPlan(planObj.id);
    if (canonicalPlan) {
      planObj.plan_key = canonicalPlan.key;
      planObj.name = canonicalPlan.name;
      planObj.employee_limit = canonicalPlan.employeeLimit;
    }

    const remainingSeconds = planObj.is_trial && planObj.trial_ends_at
      ? Math.max(1, Math.ceil((new Date(planObj.trial_ends_at).getTime() - Date.now()) / 1000))
      : planObj.subscription_expires_at
        ? Math.max(1, Math.ceil((new Date(planObj.subscription_expires_at).getTime() - Date.now()) / 1000))
        : PLAN_CACHE_TTL;

    // Cache in fast L1 memory
    memPlanCache.set(cacheKey, planObj, Math.min(60, remainingSeconds));

    if (redisClient && redisClient.status === 'ready') {
      try {
        await redisClient.set(cacheKey, JSON.stringify(planObj), 'EX', Math.min(PLAN_CACHE_TTL, remainingSeconds));
      } catch (redisErr) {
        console.warn('⚠️ Redis plan cache write error:', redisErr.message);
      }
    }

    req.plan = planObj;
    next();
  } catch (err) {
    console.error('❌ planMiddleware error:', err.message);
    return res.status(500).json({
      message: 'Unable to verify subscription plan. Please try again later.'
    });
  }
}

/**
 * Pre-write Subscription Limit Check
 * Starter: 10 Employees, 15 Jobs, 50 Items, 250MB Storage
 * Professional: 50 Employees, 100 Jobs, 500 Items, 5GB Storage
 * Enterprise: Unlimited
 */
function checkPlanLimit(limitType, options = {}) {
  return async (req, res, next) => {
    let quotaLockClient = null;
    let releaseWithResponse = false;
    let releasePromise = null;
    try {
      const companyId = req.user?.companyId || req.user?.company_id || req.customer?.companyId || req.customer?.company_id || req.proofCaller?.companyId || req.proofCaller?.company_id;
      if (companyId && !req.plan) {
        return res.status(503).json({ code: 'PLAN_CHECK_UNAVAILABLE', message: 'Could not verify your subscription. Please retry shortly.' });
      }
      const plan = req.plan || { id: 1, name: 'Starter' };
      if (!companyId && ['employee', 'job', 'inventory', 'storage'].includes(limitType)) {
        return res.status(403).json({ code: 'COMPANY_REQUIRED', message: 'A company subscription is required to verify this limit.' });
      }

      if (isUnlimitedPlan(plan)) {
        if (limitType !== 'ai_messages') return next();
      }

      const requestedUsage = typeof options.getRequestedUsage === 'function'
        ? Number(options.getRequestedUsage(req) || 0)
        : 0;
      if (!Number.isFinite(requestedUsage) || requestedUsage < 0) {
        return res.status(400).json({ code: 'INVALID_QUOTA_USAGE', message: 'The requested quota usage is invalid.' });
      }
      if (limitType === 'storage' && requestedUsage === 0) return next();

      if (limitType === 'ai_messages') {
        const quota = await consumeAIRequest(redisClient, req.user?.userId || req.user?.id, resolvePlanTier(plan));
        if (!quota.allowed) {
          return res.status(quota.status).json({ code: quota.status === 429 ? 'PLAN_LIMIT_REACHED' : 'PLAN_LIMIT_CHECK_UNAVAILABLE', message: quota.error, retryAfter: quota.retryAfter });
        }
        return next();
      }

      // Serialize count-then-create requests for bounded employee seats and
      // active jobs across workers. The lock stays held until the route has
      // completed its write and sent a response. Signup uses the matching
      // transaction-scoped employee lock.
      const lockName = limitType === 'employee' ? 'employee_seats_' : limitType === 'job' ? 'active_jobs_' : limitType === 'inventory' ? 'inventory_items_' : limitType === 'storage' ? 'company_storage_' : null;
      if (companyId && lockName) {
        quotaLockClient = await pool.connect();
        await quotaLockClient.query("SELECT pg_advisory_lock(hashtext($1 || $2))", [lockName, String(companyId)]);
        const releaseLock = () => {
          if (!releasePromise) {
            const client = quotaLockClient;
            quotaLockClient = null;
            releasePromise = client.query("SELECT pg_advisory_unlock(hashtext($1 || $2))", [lockName, String(companyId)])
              .catch((err) => console.error(`Could not release ${limitType} quota lock:`, err.message))
              .finally(() => client.release());
          }
          return releasePromise;
        };
        res.once('finish', releaseLock);
        res.once('close', releaseLock);
        releaseWithResponse = true;
      }

      let currentCount = 0;
      let maxLimit = 0;
      let limitLabel = limitType;
      let unit = '';

      if (limitType === 'employee') {
        maxLimit = getEmployeeLimit(plan.id);
        if (maxLimit === undefined) {
          return res.status(503).json({ code: 'PLAN_LIMIT_UNAVAILABLE', message: 'Could not verify the employee limit for this plan.' });
        }
        const countRes = await pool.query(
          `SELECT COUNT(*) AS count FROM users WHERE company_id = $1 AND role = 'employee'`,
          [companyId]
        );
        currentCount = parseInt(countRes.rows[0]?.count || 0, 10);
        limitLabel = 'Employees';
      } else if (limitType === 'job') {
        maxLimit = getPlanLimit(plan.id, 'activeJobsLimit');
        if (maxLimit === undefined || maxLimit === null) {
          return res.status(503).json({ code: 'PLAN_LIMIT_UNAVAILABLE', message: 'Could not verify the active job limit for this plan.' });
        }
        const countRes = await pool.query(
          `SELECT COUNT(*) AS count FROM jobs WHERE company_id = $1 AND status NOT IN ('completed', 'cancelled')`,
          [companyId]
        );
        currentCount = parseInt(countRes.rows[0]?.count || 0, 10);
        limitLabel = 'Active Jobs';
      } else if (limitType === 'inventory') {
        maxLimit = plan.max_inventory_items ?? getPlanLimit(plan.id, 'inventoryItemsLimit');
        if (maxLimit === undefined || maxLimit === null) {
          return res.status(503).json({ code: 'PLAN_LIMIT_UNAVAILABLE', message: 'Could not verify the inventory limit for this plan.' });
        }
        const countRes = await pool.query(
          `SELECT COUNT(*) AS count FROM inventory_items WHERE company_id = $1 AND (is_deleted = FALSE OR is_deleted IS NULL)`,
          [companyId]
        );
        currentCount = parseInt(countRes.rows[0]?.count || 0, 10);
        limitLabel = 'Inventory Items';
      } else if (limitType === 'storage') {
        maxLimit = plan.max_storage_bytes ?? getPlanLimit(plan.id, 'storageBytesLimit');
        if (maxLimit === undefined || maxLimit === null) {
          return res.status(503).json({ code: 'PLAN_LIMIT_UNAVAILABLE', message: 'Could not verify the storage limit for this plan.' });
        }
        const countRes = await pool.query(
          `SELECT COALESCE(SUM(file_size_bytes), 0) AS bytes FROM company_storage_usage
            WHERE company_id = $1 AND ($2::text IS NULL OR storage_key <> $2)`,
          [companyId, typeof options.getReplacementKey === 'function' ? options.getReplacementKey(req) : null]
        );
        currentCount = parseInt(countRes.rows[0]?.bytes || 0, 10);
        limitLabel = 'Storage Space';
        unit = ' bytes';
      } else {
        return res.status(400).json({ code: 'UNKNOWN_PLAN_LIMIT', message: 'This subscription limit is not supported.' });
      }

      const wouldExceed = limitType === 'storage'
        ? BigInt(currentCount) + BigInt(Math.ceil(requestedUsage)) > BigInt(maxLimit)
        : currentCount >= maxLimit;
      if (wouldExceed) {
        console.warn(`[Limit Enforcement] Blocked ${limitType} creation | Company: ${companyId} | Count: ${currentCount} / Limit: ${maxLimit}`);
        return res.status(403).json({
          code: 'PLAN_LIMIT_REACHED',
          message: `Your ${plan.name || 'Starter'} plan limit for ${limitLabel} (${maxLimit}${unit}) would be exceeded.`,
          details: {
            limitType,
            currentCount,
            maxLimit,
            requestedUsage: limitType === 'storage' ? Math.ceil(requestedUsage) : undefined,
            currentPlan: plan.name || 'Starter',
            recommendedPlan: plan.id === 2 ? 'Enterprise' : 'Professional'
          }
        });
      }

      next();
    } catch (err) {
      console.error(`❌ Plan limit check error (${limitType}):`, err);
      return res.status(503).json({ code: 'PLAN_LIMIT_CHECK_UNAVAILABLE', message: 'Could not verify your plan limit. Please retry shortly.' });
    } finally {
      if (quotaLockClient && !releaseWithResponse) {
        quotaLockClient.release();
        quotaLockClient = null;
      }
    }
  };
}

function invalidatePlanCache(companyId) {
  if (!companyId) return;
  const cacheKey = `plan:${companyId}`;
  memPlanCache.del(cacheKey);
  memPlanCache.del(`plan:${String(companyId)}`);
  if (redisClient && redisClient.status === 'ready') {
    const keys = [`plan:${companyId}`, `plan:${String(companyId)}`, `company_suspended:${companyId}`, `company_suspended:${String(companyId)}` ];
    redisClient.del(keys).catch(err => console.warn('⚠️ Redis plan cache delete error:', err.message));
  }
}

module.exports = { loadPlan, checkPlanLimit, invalidatePlanCache };
