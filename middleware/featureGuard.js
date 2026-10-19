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

function requireFeature(featureKey, featureLabel = 'premium feature') {
  return (req, res, next) => {
    const plan = req.plan;
    const userRole = req.user?.role || 'employee';

    // If plan wasn't loaded (shouldn't normally happen) — fail closed
    if (!plan) {
      return res.status(500).json({
        message: 'Unable to verify subscription plan. Please try again later.'
      });
    }

    const allowed = plan.features?.[featureKey] === true;

    if (!allowed) {
      // Customized messages based on feature and role
      let friendlyMessage = `This feature is not available on your current plan.`;

      if (featureKey === 'ai_assistant') {
        if (userRole === 'owner') {
          friendlyMessage = "The AI assistant is not included in your current plan. Review available plans to enable it.";
        } else {
          friendlyMessage = "The AI assistant is not included in your company's current plan. Ask your owner about available plans.";
        }
      } else if (featureKey === 'location_tracking' || featureKey === 'tracking') {
        if (userRole === 'owner') {
          friendlyMessage = "Location tracking is not included in your current plan. Review available plans to enable it.";
        } else {
          friendlyMessage = "Location tracking is not included in your company's current plan. Ask your owner about available plans.";
        }
      } else if (featureKey === 'payroll') {
        if (userRole === 'owner') {
          friendlyMessage = "Payroll is not included in your current plan. Review available plans to enable it.";
        } else {
          friendlyMessage = "Payroll is not included in your company's current plan. Ask your owner about available plans.";
        }
      } else if (featureKey === 'advanced_reports' || featureKey === 'reports') {
        if (userRole === 'owner') {
          friendlyMessage = "Advanced reports are not included in your current plan. Review available plans to enable them.";
        } else {
          friendlyMessage = "Advanced reports are not included in your company's current plan. Ask your owner about available plans.";
        }
      } else {
        // Generic fallback
        if (userRole === 'owner') {
          friendlyMessage = `✨ ${featureLabel.charAt(0).toUpperCase() + featureLabel.slice(1)} is a premium feature! Upgrade your plan to enjoy more power.`;
        } else {
          friendlyMessage = `🔒 ${featureLabel.charAt(0).toUpperCase() + featureLabel.slice(1)} is currently locked for your team. Your owner can unlock it with an upgrade.`;
        }
      }

      return res.status(403).json({
        message: friendlyMessage,
        feature: featureKey,
        current_plan: plan.name,
        upgrade_url: '/owner/billing',
        upgrade_required: true,
        user_role: userRole
      });
    }

    next();
  };
}

module.exports = { requireFeature };
