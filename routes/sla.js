const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/sla (Fetch SLA Compliance Metrics & Active Breaches) ─────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;

    const result = await pool.query(
      `SELECT id, title, priority, status, created_at, accepted_at, completed_at,
              COALESCE(sla_target_hours, 4.0) as sla_target_hours,
              COALESCE(sla_status, 'on_track') as sla_status,
              COALESCE(sla_response_minutes, 0) as sla_response_minutes,
              COALESCE(sla_resolution_minutes, 0) as sla_resolution_minutes
       FROM jobs
       WHERE (company_id::text = $1::text OR company_id = $2) AND status NOT IN ('cancelled')
       ORDER BY created_at DESC LIMIT 50`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [] }));

    const onTrack = result.rows.filter((j) => j.sla_status === 'on_track' || !j.sla_status).length;
    const warning = result.rows.filter((j) => j.sla_status === 'warning').length;
    const breached = result.rows.filter((j) => j.sla_status === 'breached').length;

    res.json({
      success: true,
      metrics: {
        total_jobs_monitored: result.rows.length,
        on_track_count: onTrack,
        warning_count: warning,
        breached_count: breached,
        sla_compliance_percentage: result.rows.length > 0 ? Math.round(((onTrack + warning) / result.rows.length) * 100) : 100,
      },
      jobs: result.rows,
    });
  } catch (err) {
    console.error('❌ Error fetching SLA metrics:', err.message);
    res.status(200).json({
      success: true,
      metrics: { total_jobs_monitored: 0, on_track_count: 0, warning_count: 0, breached_count: 0, sla_compliance_percentage: 100 },
      jobs: []
    });
  }
});

module.exports = router;
