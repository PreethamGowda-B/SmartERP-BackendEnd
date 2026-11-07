const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');
const { requireFeature } = require('../middleware/featureGuard');

const SCHEDULER_ROLES = new Set(['owner', 'admin', 'hr', 'service_manager']);

function canViewAutoSchedule(role) {
  return SCHEDULER_ROLES.has(String(role || '').toLowerCase());
}

function buildWorkloadRankings(employees) {
  return employees.map((emp) => ({
    user_id: emp.id,
    name: emp.name,
    position: emp.position || 'Service Engineer',
    active_jobs: emp.active_job_count || 0,
    recommendation_reason: `Current recorded workload: ${emp.active_job_count || 0} active jobs. No skill, certification, or machine compatibility data was used.`,
  }));
}

// ─── POST /api/ai/auto-schedule (Engineer Match Ranking Engine) ───────────
router.post('/', authenticateToken, loadPlan, requireFeature('ai_assistant', 'AI assistant'), async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }
    const role = String(req.user.role || '').toLowerCase();
    if (!canViewAutoSchedule(role)) {
      return res.status(403).json({ message: 'Only company operations managers may view employee scheduling recommendations.' });
    }

    const employees = await pool.query(
      `SELECT u.id, u.name, ep.position, ep.status, ep.active_job_count
       FROM users u
       LEFT JOIN employee_profiles ep ON u.id::text = ep.user_id::text
         AND ep.company_id::text = $1::text
       WHERE u.company_id::text = $1::text AND COALESCE(ep.status, 'active') = 'active'
       ORDER BY COALESCE(ep.active_job_count, 0) ASC, u.name ASC`,
      [String(companyId)]
    );

    const rankings = buildWorkloadRankings(employees.rows);

    res.json({ success: true, ranking_basis: 'recorded_active_job_count', rankings });
  } catch (err) {
    console.error('❌ Error executing auto schedule match:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
module.exports.canViewAutoSchedule = canViewAutoSchedule;
module.exports.buildWorkloadRankings = buildWorkloadRankings;
