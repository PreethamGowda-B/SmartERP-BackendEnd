const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/sla (Fetch Live SLA Compliance Metrics & Dynamic Timers) ─────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && req.user.role !== 'super_admin') {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }

    const query = req.user.role === 'super_admin'
      ? `SELECT id, title, priority, status, service_type, created_at, assigned_at, accepted_at,
                travel_started_at, site_reached_at, repair_started_at, completed_at, closed_at,
                customer_name, machine_id,
                COALESCE(sla_target_hours, CASE 
                  WHEN priority = 'urgent' OR service_type = 'breakdown' THEN 2.0
                  WHEN priority = 'high' THEN 4.0
                  ELSE 8.0
                END) as target_hours
         FROM jobs
         WHERE status NOT IN ('cancelled')
         ORDER BY created_at DESC LIMIT 50`
      : `SELECT id, title, priority, status, service_type, created_at, assigned_at, accepted_at,
                travel_started_at, site_reached_at, repair_started_at, completed_at, closed_at,
                customer_name, machine_id,
                COALESCE(sla_target_hours, CASE 
                  WHEN priority = 'urgent' OR service_type = 'breakdown' THEN 2.0
                  WHEN priority = 'high' THEN 4.0
                  ELSE 8.0
                END) as target_hours
         FROM jobs
         WHERE company_id::text = $1::text AND status NOT IN ('cancelled')
         ORDER BY created_at DESC LIMIT 50`;

    const params = req.user.role === 'super_admin' ? [] : [String(companyId)];
    const result = await pool.query(query, params).catch(() => ({ rows: [] }));

    const now = new Date();

    const jobsWithSla = result.rows.map((j) => {
      const createdAt = new Date(j.created_at);
      const targetHours = parseFloat(j.target_hours) || 4.0;
      const deadline = new Date(createdAt.getTime() + targetHours * 60 * 60 * 1000);

      // Timestamps duration calculations (in minutes)
      const responseMins = j.accepted_at ? Math.round((new Date(j.accepted_at) - createdAt) / (1000 * 60)) : (j.assigned_at ? Math.round((new Date(j.assigned_at) - createdAt) / (1000 * 60)) : Math.round((now - createdAt) / (1000 * 60)));
      const travelMins = j.site_reached_at && j.travel_started_at ? Math.round((new Date(j.site_reached_at) - new Date(j.travel_started_at)) / (1000 * 60)) : 0;
      const repairMins = j.completed_at && (j.repair_started_at || j.site_reached_at) ? Math.round((new Date(j.completed_at) - new Date(j.repair_started_at || j.site_reached_at)) / (1000 * 60)) : 0;
      const totalResolutionMins = j.completed_at ? Math.round((new Date(j.completed_at) - createdAt) / (1000 * 60)) : Math.round((now - createdAt) / (1000 * 60));

      const remainingMins = Math.round((deadline - (j.completed_at ? new Date(j.completed_at) : now)) / (1000 * 60));

      let slaStatus = 'on_track';
      if (j.completed_at) {
        slaStatus = totalResolutionMins <= targetHours * 60 ? 'on_track' : 'breached';
      } else if (remainingMins < 0) {
        slaStatus = 'breached';
      } else if (remainingMins < 60) {
        slaStatus = 'warning';
      }

      return {
        ...j,
        sla_target_hours: targetHours,
        sla_status: slaStatus,
        sla_response_minutes: Math.max(0, responseMins),
        sla_travel_minutes: Math.max(0, travelMins),
        sla_repair_minutes: Math.max(0, repairMins),
        sla_resolution_minutes: Math.max(0, totalResolutionMins),
        remaining_minutes: remainingMins,
        deadline: deadline.toISOString(),
      };
    });

    const onTrack = jobsWithSla.filter((j) => j.sla_status === 'on_track').length;
    const warning = jobsWithSla.filter((j) => j.sla_status === 'warning').length;
    const breached = jobsWithSla.filter((j) => j.sla_status === 'breached').length;

    res.json({
      success: true,
      metrics: {
        total_jobs_monitored: jobsWithSla.length,
        on_track_count: onTrack,
        warning_count: warning,
        breached_count: breached,
        sla_compliance_percentage: jobsWithSla.length > 0 ? Math.round(((onTrack + warning) / jobsWithSla.length) * 100) : 100,
        average_response_minutes: jobsWithSla.length > 0 ? Math.round(jobsWithSla.reduce((sum, j) => sum + j.sla_response_minutes, 0) / jobsWithSla.length) : 0,
        average_resolution_minutes: jobsWithSla.length > 0 ? Math.round(jobsWithSla.reduce((sum, j) => sum + j.sla_resolution_minutes, 0) / jobsWithSla.length) : 0,
      },
      jobs: jobsWithSla,
    });
  } catch (err) {
    console.error('❌ Error fetching SLA metrics:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
