/**
 * planMiddleware.js
 * Centralized subscription plan loader and atomic limit enforcement middleware.
 */

const { pool } = require('../db');
const { redisClient } = require('../utils/redis');

const PLAN_CACHE_TTL = 300; // 5 minutes in seconds

async function loadPlan(req, res, next) {
  try {
    const companyId = req.user?.companyId;
    if (!companyId) return next();

    const cacheKey = `plan:${companyId}`;

    if (redisClient && redisClient.status === 'ready') {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          req.plan = JSON.parse(cached);
          return next();
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
          `SELECT id, name, employee_limit, max_inventory_items, max_material_requests, messages_history_days, features FROM plans WHERE id = 1`
        );
        if (freeResult.rows.length > 0) {
          req.plan = { ...freeResult.rows[0], is_trial: false, days_remaining: 0, trial_ends_at: null };
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
    const now = new Date();
    const trialEnds = data.trial_ends_at ? new Date(data.trial_ends_at) : null;
    const trialActive = data.is_on_trial && trialEnds && trialEnds > now;

    const subscriptionExpires = data.subscription_expires_at ? new Date(data.subscription_expires_at) : null;
    const isActuallyExpired = !data.is_on_trial && subscriptionExpires && subscriptionExpires <= now;

    let planObj;

    if (isActuallyExpired) {
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

    if (redisClient && redisClient.status === 'ready') {
      try {
        await redisClient.set(cacheKey, JSON.stringify(planObj), 'EX', PLAN_CACHE_TTL);
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
 * Free: 10 Employees, 15 Jobs, 50 Items, 250MB Storage, 20 AI Msgs/day
 * Basic: 50 Employees, 100 Jobs, 500 Items, 5GB Storage, 300 AI Msgs/day
 * Pro: Unlimited
 */
function checkPlanLimit(limitType) {
  return async (req, res, next) => {
    try {
      const companyId = req.user?.companyId;
      const plan = req.plan || { id: 1, name: 'Free' };

      if (plan.id >= 3 || (plan.name && plan.name.toLowerCase().includes('pro'))) {
        return next();
      }

      let currentCount = 0;
      let maxLimit = 0;
      let limitLabel = limitType;
      let unit = '';

      if (limitType === 'employee') {
        maxLimit = plan.id === 2 ? 50 : 10;
        const countRes = await pool.query(
          `SELECT COUNT(*) AS count FROM users WHERE company_id = $1 AND role = 'employee'`,
          [companyId]
        );
        currentCount = parseInt(countRes.rows[0]?.count || 0, 10);
        limitLabel = 'Employees';
      } else if (limitType === 'job') {
        maxLimit = plan.id === 2 ? 100 : 15;
        const countRes = await pool.query(
          `SELECT COUNT(*) AS count FROM jobs WHERE company_id = $1 AND status NOT IN ('completed', 'cancelled')`,
          [companyId]
        );
        currentCount = parseInt(countRes.rows[0]?.count || 0, 10);
        limitLabel = 'Active Jobs';
      } else if (limitType === 'inventory') {
        maxLimit = plan.id === 2 ? 500 : 50;
        const countRes = await pool.query(
          `SELECT COUNT(*) AS count FROM inventory_items WHERE company_id = $1 AND (is_deleted = FALSE OR is_deleted IS NULL)`,
          [companyId]
        );
        currentCount = parseInt(countRes.rows[0]?.count || 0, 10);
        limitLabel = 'Inventory Items';
      } else if (limitType === 'storage') {
        // Bytes: 250MB vs 5GB
        maxLimit = plan.id === 2 ? 5 * 1024 * 1024 * 1024 : 250 * 1024 * 1024;
        const countRes = await pool.query(
          `SELECT COALESCE(SUM(file_size), 0) AS bytes FROM documents WHERE company_id = $1`,
          [companyId]
        );
        currentCount = parseInt(countRes.rows[0]?.bytes || 0, 10);
        limitLabel = 'Storage Space';
        unit = 'MB';
      } else if (limitType === 'ai_messages') {
        maxLimit = plan.id === 2 ? 300 : 20;
        const countRes = await pool.query(
          `SELECT COUNT(*) AS count FROM ai_chat_logs WHERE company_id = $1 AND created_at >= CURRENT_DATE`,
          [companyId]
        ).catch(() => ({ rows: [{ count: 0 }] }));
        currentCount = parseInt(countRes.rows[0]?.count || 0, 10);
        limitLabel = 'Daily AI Messages';
      }

      if (currentCount >= maxLimit) {
        console.warn(`[Limit Enforcement] Blocked ${limitType} creation | Company: ${companyId} | Count: ${currentCount} / Limit: ${maxLimit}`);
        return res.status(403).json({
          code: 'PLAN_LIMIT_REACHED',
          message: `Your ${plan.name || 'Free'} Plan limit for ${limitLabel} (${maxLimit}${unit}) has been reached.`,
          details: {
            limitType,
            currentCount,
            maxLimit,
            currentPlan: plan.name || 'Free',
            recommendedPlan: plan.id === 2 ? 'Pro' : 'Basic'
          }
        });
      }

      next();
    } catch (err) {
      console.error(`❌ Plan limit check error (${limitType}):`, err);
      next();
    }
  };
}

function invalidatePlanCache(companyId) {
  if (!companyId) return;
  if (redisClient && redisClient.status === 'ready') {
    const keys = [`plan:${companyId}`, `plan:${String(companyId)}`, `company_suspended:${companyId}`, `company_suspended:${String(companyId)}` ];
    redisClient.del(keys).catch(err => console.warn('⚠️ Redis plan cache delete error:', err.message));
  }
}

module.exports = { loadPlan, checkPlanLimit, invalidatePlanCache };
