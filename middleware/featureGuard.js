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
          friendlyMessage = "😄 Wow, someone is curious to chat with the AI! But this feature is available only for Pro plan users. Upgrade your company's SmartERP subscription to unlock the AI Assistant.";
        } else {
          friendlyMessage = "🤖 I'd love to chat with you! But your company is currently on the Free plan. Ask your owner to upgrade to the Pro plan to unlock AI features.";
        }
      } else if (featureKey === 'location_tracking' || featureKey === 'tracking') {
        if (userRole === 'owner') {
          friendlyMessage = "🛰️ Trying to see where the magic happens? Precise location tracking is a Pro feature! Upgrade to keep a pulse on your operations.";
        } else {
          friendlyMessage = "📍 Location tracking is currently locked for your company. Your owner can unlock this by upgrading to the Pro plan.";
        }
      } else if (featureKey === 'payroll') {
        if (userRole === 'owner') {
          friendlyMessage = "💰 Ready to streamline your payday? Automated payroll generation is available on Basic and Pro plans. Upgrade now to save hours of manual work!";
        } else {
          friendlyMessage = "💸 Payroll features are locked. Ask your owner to upgrade to a paid plan to enable this.";
        }
      } else if (featureKey === 'advanced_reports' || featureKey === 'reports') {
        if (userRole === 'owner') {
          friendlyMessage = "📊 Hungry for data? Deep analytics and advanced reporting are reserved for our Pro users. Upgrade and start making data-driven decisions!";
        } else {
          friendlyMessage = "📈 Advanced reports are available only on higher plans. Your owner can unlock this for the whole team!";
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
