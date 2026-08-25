const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── POST /api/saas/onboarding (Self-Service Company Initialization Wizard) ──
router.post('/onboarding', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }
    const { company_name, industry_type = 'CNC Service', estimated_machines = 10, plan_tier = 'pro' } = req.body;

    await pool.query(
      `INSERT INTO saas_subscriptions (company_id, plan_tier, billing_cycle, status, current_period_end, created_at)
       VALUES ($1, $2, 'monthly', 'active', NOW() + INTERVAL '30 days', NOW())
       ON CONFLICT (company_id) DO UPDATE SET plan_tier = EXCLUDED.plan_tier, status = 'active'`,
      [companyId, plan_tier]
    );

    res.json({
      success: true,
      onboarding: {
        company_id: companyId,
        company_name: company_name || 'CNC Service Enterprise',
        plan_tier,
        status: 'initialized',
        features_unlocked: ['Digital Twin Dashboard', 'SLA Engine', 'Warranty Claims', 'AI Operations Copilot', 'Executive BI'],
      },
    });
  } catch (err) {
    console.error('❌ Error executing SaaS onboarding wizard:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
