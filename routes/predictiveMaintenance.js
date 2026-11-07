const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');
const { requireFeature } = require('../middleware/featureGuard');

const MACHINE_HEALTH_READ_ROLES = new Set(['owner', 'admin', 'manager', 'service_manager', 'service_engineer', 'super_admin']);

function resolveCompanyScope(user, requestedCompanyId) {
  const role = String(user?.role || '').toLowerCase();
  if (!MACHINE_HEALTH_READ_ROLES.has(role)) return { error: 'FORBIDDEN' };
  const ownCompanyId = user?.companyId || user?.company_id;
  const companyId = role === 'super_admin' ? requestedCompanyId : ownCompanyId;
  if (!companyId) return { error: 'COMPANY_REQUIRED' };
  if (role !== 'super_admin' && requestedCompanyId && String(requestedCompanyId) !== String(ownCompanyId)) {
    return { error: 'FORBIDDEN' };
  }
  return { companyId: String(companyId) };
}

// ─── GET /api/ai/predictive-maintenance (AI Failure Probability Scoring) ────
router.get('/', authenticateToken, loadPlan, requireFeature('ai_assistant', 'AI assistant'), async (req, res) => {
  try {
    const scope = resolveCompanyScope(req.user, req.query.companyId);
    if (scope.error === 'FORBIDDEN') {
      return res.status(403).json({ message: 'Your role cannot view company machine health.' });
    }
    if (scope.error === 'COMPANY_REQUIRED') {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }
    const result = await pool.query(
      `SELECT m.id, m.machine_name, m.serial_number, m.make, m.model, m.controller_type, m.health_score, m.spindle_hours, c.name as customer_name
         FROM customer_machines m
         LEFT JOIN customers c ON m.customer_id::text = c.id::text
          AND c.company_id::text = m.company_id::text
        WHERE m.company_id::text = $1::text
        ORDER BY m.health_score ASC`,
      [scope.companyId]
    );

    const predictions = result.rows.map((m) => {
      const rawHealthScore = m.health_score == null ? NaN : Number(m.health_score);
      const healthScore = Number.isFinite(rawHealthScore) ? Math.min(100, Math.max(0, rawHealthScore)) : null;
      const rawSpindleHours = m.spindle_hours == null ? 0 : Number(m.spindle_hours);
      const spindleHours = Number.isFinite(rawSpindleHours) ? Math.max(0, rawSpindleHours) : 0;
      const breakdownRisk = healthScore == null
        ? null
        : Math.min(95, Math.max(10, 100 - healthScore + Math.floor(spindleHours / 500)));
      return {
        ...m,
        breakdown_risk_percentage: breakdownRisk,
        recommended_pm_date: breakdownRisk == null
          ? null
          : new Date(Date.now() + (100 - breakdownRisk) * 86400000).toISOString().split('T')[0],
        recommended_spares: [],
        risk_method: 'rule_based_heuristic',
        risk_basis: healthScore == null
          ? 'Health score is unavailable; no risk estimate or maintenance date was calculated.'
          : 'Calculated from the recorded health score and spindle hours only; this is not a verified failure probability.',
      };
    });

    res.json({ success: true, scope: 'company', predictions });
  } catch (err) {
    console.error('❌ Error fetching predictive maintenance analytics:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
module.exports.resolveCompanyScope = resolveCompanyScope;
