/**
 * featureGuard.js
 * Returns a middleware that blocks access if the company's plan does not
 * include the given feature flag.
 *
 * Usage:
 *   router.post('/payroll', authenticateToken, loadPlan, requireFeature('payroll'), handler)
 *
 * Requires loadPlan middleware to have run first (populates req.plan).
 */

function requireFeature(featureKey) {
  return (req, res, next) => {
    const plan = req.plan;

    // If plan wasn't loaded (shouldn't normally happen) — fail closed
    if (!plan) {
      return res.status(500).json({
        message: 'Unable to verify subscription plan. Please try again later.'
      });
    }

    const allowed = plan.features?.[featureKey] === true;

    if (!allowed) {
      return res.status(403).json({
        message: `This feature is not available on your current plan.`,
        feature: featureKey,
        current_plan: plan.name,
        upgrade_url: '/billing',
        // Upgrade hint for the frontend to show modal
        upgrade_required: true
      });
    }

    next();
  };
}

module.exports = { requireFeature };
