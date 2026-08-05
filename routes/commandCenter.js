const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/command-center (Executive CNC Operations Hub Payload) ───────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;

    // 1. Active Jobs Count & Breakdown Counts
    const jobsRes = await pool.query(
      `SELECT status, priority, service_type, count(*) as count
       FROM jobs
       WHERE company_id::text = $1::text AND status NOT IN ('completed', 'cancelled')
       GROUP BY status, priority, service_type`,
      [companyId]
    ).catch(() => ({ rows: [] }));

    // 2. Engineers Status Counters
    const engineersRes = await pool.query(
      `SELECT status, count(*) as count
       FROM employee_profiles
       WHERE company_id::text = $1::text
       GROUP BY status`,
      [companyId]
    ).catch(() => ({ rows: [] }));

    // 3. Machines Health Summary
    const machinesRes = await pool.query(
      `SELECT id, machine_name, health_score, status FROM customer_machines WHERE company_id::text = $1::text`,
      [companyId]
    ).catch(() => ({ rows: [] }));

    // 4. SLA Warning Flags & Breaches Count
    const slaRes = await pool.query(
      `SELECT count(*) as count FROM jobs WHERE company_id::text = $1::text AND sla_status = 'breached'`,
      [companyId]
    ).catch(() => ({ rows: [] }));

    // 5. Active Remote Support Sessions
    const remoteRes = await pool.query(
      `SELECT count(*) as count FROM remote_support_sessions WHERE company_id::text = $1::text AND status = 'in_progress'`,
      [companyId]
    ).catch(() => ({ rows: [] }));

    // 6. Active Warranty Claims
    const warrantyRes = await pool.query(
      `SELECT count(*) as count FROM warranty_claims WHERE company_id::text = $1::text AND status IN ('submitted', 'under_review')`,
      [companyId]
    ).catch(() => ({ rows: [] }));

    // 7. Top Alarm Codes Frequency
    const alarmsRes = await pool.query(
      `SELECT alarm_code, count(*) as frequency FROM jobs WHERE company_id::text = $1::text AND alarm_code IS NOT NULL AND alarm_code != '' GROUP BY alarm_code ORDER BY frequency DESC LIMIT 5`,
      [companyId]
    ).catch(() => ({ rows: [] }));

    res.json({
      success: true,
      command_center: {
        active_jobs_total: jobsRes.rows.reduce((sum, r) => sum + parseInt(r.count), 0),
        breakdowns_total: jobsRes.rows.filter((r) => r.service_type === 'breakdown').reduce((sum, r) => sum + parseInt(r.count), 0),
        engineers_status: engineersRes.rows,
        machines_total: machinesRes.rows.length,
        machines_breakdown: machinesRes.rows.filter((m) => m.status === 'breakdown').length,
        sla_breaches_total: parseInt(slaRes.rows[0]?.count || 0),
        remote_sessions_active: parseInt(remoteRes.rows[0]?.count || 0),
        pending_warranty_claims: parseInt(warrantyRes.rows[0]?.count || 0),
        top_alarm_codes: alarmsRes.rows,
      },
    });
  } catch (err) {
    console.error('❌ Error fetching Command Center payload:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
