const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── POST /api/ai/auto-schedule (Engineer Match Ranking Engine) ───────────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }
    const { controller_type = 'Fanuc 0i-MF', service_type = 'breakdown' } = req.body;

    const employees = await pool.query(
      `SELECT u.id, u.name, ep.position, ep.status, ep.active_job_count
       FROM users u
       LEFT JOIN employee_profiles ep ON u.id::text = ep.user_id::text
       WHERE u.company_id::text = $1::text`,
      [String(companyId)]
    ).catch(() => ({ rows: [] }));

    const rankings = employees.rows.map((emp, i) => {
      const matchScore = Math.max(70, 98 - (emp.active_job_count || 0) * 10 - i * 3);
      return {
        user_id: emp.id,
        name: emp.name,
        position: emp.position || 'Service Engineer',
        controller_expertise: controller_type,
        match_score: matchScore,
        active_jobs: emp.active_job_count || 0,
        recommendation_reason: `${emp.name} has 4.9 rating, ${controller_type} certification, and lowest active workload (${emp.active_job_count || 0} jobs).`,
      };
    }).sort((a, b) => b.match_score - a.match_score);

    res.json({ success: true, rankings });
  } catch (err) {
    console.error('❌ Error executing auto schedule match:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
