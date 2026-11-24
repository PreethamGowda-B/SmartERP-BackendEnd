const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── POST /api/saas/onboarding (Self-Service Company Initialization Wizard) ──
router.post('/onboarding', authenticateToken, async (req, res) => {
  try {
    const userRole = String(req.user?.role || '').toLowerCase();
    if (userRole !== 'owner' && userRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Only company owners can configure company onboarding and subscriptions.',
      });
    }

    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing company context.' });
    }

    const { company_name, industry_type = 'CNC Service', estimated_machines = 10 } = req.body;

    // Check authoritative company subscription status from database
    const compRes = await pool.query(
      'SELECT id, company_name, plan_id, subscription_status, is_on_trial FROM companies WHERE id = $1',
      [companyId]
    );

    if (compRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Company not found.' });
    }

    const company = compRes.rows[0];

    // Determine verified plan tier based on actual paid/trial entitlements
    let verifiedTier = 'starter';
    if (company.plan_id === 3 || company.is_on_trial) {
      verifiedTier = 'pro';
    } else if (company.plan_id === 2) {
      verifiedTier = 'standard';
    }

    await pool.query(
      `INSERT INTO saas_subscriptions (company_id, plan_tier, billing_cycle, status, current_period_end, created_at)
       VALUES ($1, $2, 'monthly', 'active', NOW() + INTERVAL '30 days', NOW())
       ON CONFLICT (company_id) DO UPDATE SET plan_tier = EXCLUDED.plan_tier, status = 'active'`,
      [companyId, verifiedTier]
    );

    res.json({
      success: true,
      onboarding: {
        company_id: companyId,
        company_name: company_name || company.company_name || 'CNC Service Enterprise',
        plan_tier: verifiedTier,
        status: 'initialized',
        features_unlocked: verifiedTier === 'pro'
          ? ['Digital Twin Dashboard', 'SLA Engine', 'Warranty Claims', 'AI Operations Copilot', 'Executive BI']
          : ['Core Dashboard', 'Job Management', 'Inventory Tracking'],
      },
    });
  } catch (err) {
    console.error('❌ Error executing SaaS onboarding wizard:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

module.exports = router;
