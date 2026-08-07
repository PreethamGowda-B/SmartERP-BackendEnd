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
      `SELECT status, priority, service_type, created_at, scheduled_at, assigned_employee_id, count(*) as count
       FROM jobs
       WHERE (company_id::text = $1::text OR company_id = $2) AND status NOT IN ('completed', 'cancelled')
       GROUP BY status, priority, service_type, created_at, scheduled_at, assigned_employee_id`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [] }));

    // 2. Technicians Online (Clocked in today without clock_out)
    const techOnlineRes = await pool.query(
      `SELECT count(DISTINCT user_id) as count
       FROM attendance
       WHERE (company_id::text = $1::text OR company_id = $2)
         AND date = CURRENT_DATE
         AND clock_out_time IS NULL`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [{ count: 0 }] }));

    // 3. Machines Health & Breakdown Summary
    const machinesRes = await pool.query(
      `SELECT id, machine_name, health_score, status FROM customer_machines WHERE company_id::text = $1::text OR company_id = $2`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [] }));

    // 4. SLA Warning Flags & Breaches Count
    const slaRes = await pool.query(
      `SELECT count(*) as count FROM jobs WHERE (company_id::text = $1::text OR company_id = $2) AND sla_status = 'breached'`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [{ count: 0 }] }));

    // 5. Active Remote Support Sessions
    const remoteRes = await pool.query(
      `SELECT count(*) as count FROM remote_support_sessions WHERE (company_id::text = $1::text OR company_id = $2) AND status = 'in_progress'`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [{ count: 0 }] }));

    // 6. Active Warranty Claims
    const warrantyRes = await pool.query(
      `SELECT count(*) as count FROM warranty_claims WHERE (company_id::text = $1::text OR company_id = $2) AND status IN ('submitted', 'under_review')`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [{ count: 0 }] }));

    // 7. Top Alarm Codes Frequency
    const alarmsRes = await pool.query(
      `SELECT alarm_code, count(*) as frequency
       FROM jobs
       WHERE (company_id::text = $1::text OR company_id = $2) AND alarm_code IS NOT NULL AND alarm_code != ''
       GROUP BY alarm_code ORDER BY frequency DESC LIMIT 5`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [] }));

    // 8. Recent Service Tickets / Jobs (Latest 10)
    const recentJobsRes = await pool.query(
      `SELECT id, title, priority, status, service_type, created_at, customer_name
       FROM jobs
       WHERE (company_id::text = $1::text OR company_id = $2)
       ORDER BY created_at DESC LIMIT 10`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [] }));

    // 9. Recent System Activities / Audit Trail (Latest 10)
    const activitiesRes = await pool.query(
      `SELECT id, user_id, action, details, created_at
       FROM activities
       ORDER BY created_at DESC LIMIT 10`,
    ).catch(() => ({ rows: [] }));

    // 10. Recent Material Requests / Inventory Movements (Latest 5)
    const inventoryRes = await pool.query(
      `SELECT id, item_name, quantity, status, requested_by, created_at
       FROM material_requests
       WHERE (company_id::text = $1::text OR company_id = $2)
       ORDER BY created_at DESC LIMIT 5`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [] }));

    const activeJobsTotal = jobsRes.rows.reduce((sum, r) => sum + parseInt(r.count || 1), 0);
    const breakdownsTotal = jobsRes.rows.filter((r) => r.service_type === 'breakdown').reduce((sum, r) => sum + parseInt(r.count || 1), 0);
    const highPriorityTotal = jobsRes.rows.filter((r) => r.priority === 'high' || r.priority === 'urgent').reduce((sum, r) => sum + parseInt(r.count || 1), 0);
    const pendingAssignmentsTotal = jobsRes.rows.filter((r) => !r.assigned_employee_id).reduce((sum, r) => sum + parseInt(r.count || 1), 0);

    res.json({
      success: true,
      command_center: {
        active_jobs_total: activeJobsTotal,
        breakdowns_total: breakdownsTotal,
        high_priority_total: highPriorityTotal,
        pending_assignments_total: pendingAssignmentsTotal,
        technicians_online: parseInt(techOnlineRes.rows[0]?.count || 0),
        machines_total: machinesRes.rows.length,
        machines_breakdown: machinesRes.rows.filter((m) => m.status === 'breakdown').length,
        sla_breaches_total: parseInt(slaRes.rows[0]?.count || 0),
        remote_sessions_active: parseInt(remoteRes.rows[0]?.count || 0),
        pending_warranty_claims: parseInt(warrantyRes.rows[0]?.count || 0),
        top_alarm_codes: alarmsRes.rows,
        recent_jobs: recentJobsRes.rows,
        recent_activities: activitiesRes.rows,
        recent_inventory_movements: inventoryRes.rows,
      },
    });
  } catch (err) {
    console.error('❌ Error fetching Command Center payload:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
