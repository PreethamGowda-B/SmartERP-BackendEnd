const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');
const { requireFeature } = require('../middleware/featureGuard');
const { cacheMiddleware } = require('../middleware/cache');

// ─── Startup: ensure all columns used by reports exist ───────────────────────
async function ensureReportColumns() {
    try {
        // Attendance
        await pool.query('ALTER TABLE attendance ADD COLUMN IF NOT EXISTS working_hours NUMERIC');
        await pool.query('ALTER TABLE attendance ADD COLUMN IF NOT EXISTS is_late BOOLEAN DEFAULT false');
        
        // Jobs
        await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS employee_status VARCHAR(50)');
        await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP');
        await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP');
        await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0');
        
        // Material Requests
        await pool.query('ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS unit VARCHAR(20)');
        await pool.query('ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS notes TEXT');
        
        // Inventory
        await pool.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS unit VARCHAR(20)');
    } catch (err) {
        console.error('⚠️  ensureReportColumns warning:', err.message);
    }
}



// ─── Helpers ──────────────────────────────────────────────────────────────────

function dateRangeFilter(period, dateColumn, startIdx) {
    const now = new Date();
    let start = new Date(now);

    switch (period) {
        case 'week': start.setDate(now.getDate() - 7); break;
        case 'quarter': start.setMonth(now.getMonth() - 3); break;
        case 'year': start.setFullYear(now.getFullYear() - 1); break;
        default: start.setMonth(now.getMonth() - 1); break;
    }

    return {
        clause: `AND ${dateColumn} >= $${startIdx} AND ${dateColumn} <= $${startIdx + 1}`,
        params: [start.toISOString(), now.toISOString()],
    };
}

// Safe query — returns empty array/object on error instead of throwing
async function safeQuery(sql, params, fallback = []) {
    try {
        const result = await pool.query(sql, params);
        return result.rows;
    } catch (e) {
        console.error('⚠️  Report safe query error:', e.message, '\nSQL:', sql.slice(0, 200));
        return fallback;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OWNER REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/reports/attendance?period=week|month|quarter|year
 * Requires: advanced_reports (Basic+ plan)
 */
router.get('/attendance', authenticateToken, loadPlan, requireFeature('advanced_reports'), async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        const companyId = req.user.companyId;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'a.date', 2);

        const employees = await safeQuery(
            `SELECT
         u.id, u.name, u.email,
         COUNT(a.id)                                                    AS total_days,
         COUNT(CASE WHEN a.status = 'present' THEN 1 END)              AS days_present,
         COUNT(CASE WHEN a.status = 'half_day' THEN 1 END)             AS half_days,
         COUNT(CASE WHEN a.status = 'absent'  THEN 1 END)              AS days_absent,
         COUNT(CASE WHEN COALESCE(a.is_late, false) = true THEN 1 END) AS late_count,
         ROUND(COALESCE(SUM(COALESCE(a.working_hours, 0)), 0)::numeric, 2) AS total_hours,
         ROUND(COALESCE(AVG(COALESCE(a.working_hours, 0)), 0)::numeric, 2) AS avg_hours_per_day
       FROM users u
       LEFT JOIN attendance a ON a.user_id = u.id ${clause}
       WHERE u.company_id = $1 AND u.role = 'employee'
       GROUP BY u.id, u.name, u.email
       ORDER BY u.name ASC`,
            [companyId, ...params],
            []
        );

        const totalsRows = await safeQuery(
            `SELECT
         COUNT(DISTINCT a.user_id)                                      AS employees_with_records,
         COUNT(a.id)                                                    AS total_records,
         COUNT(CASE WHEN a.status = 'present' THEN 1 END)              AS total_present,
         COUNT(CASE WHEN a.status = 'absent'  THEN 1 END)              AS total_absent,
         ROUND(COALESCE(SUM(COALESCE(a.working_hours, 0)), 0)::numeric, 2) AS total_hours
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       WHERE u.company_id = $1 ${clause}`,
            [companyId, ...params],
            [{}]
        );

        res.json({ period, totals: totalsRows[0] || {}, employees });
    } catch (err) {
        console.error('❌ Reports/attendance error:', err.message);
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

/**
 * GET /api/reports/jobs?period=week|month|quarter|year
 * Requires: advanced_reports (Basic+ plan)
 */
router.get('/jobs', authenticateToken, loadPlan, requireFeature('advanced_reports'), cacheMiddleware(300), async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        const companyId = req.user.companyId;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'j.created_at', 2);

        const summaryRows = await safeQuery(
            `SELECT
         COUNT(*)                                                              AS total,
         COUNT(CASE WHEN j.status = 'completed' THEN 1 END)                     AS completed,
         COUNT(CASE WHEN j.status IN ('open','in_progress','active') THEN 1 END) AS in_progress,
         COUNT(CASE WHEN COALESCE(j.employee_status,'') = 'declined' THEN 1 END) AS declined,
         COUNT(CASE WHEN COALESCE(j.employee_status,'') = 'pending'  THEN 1 END) AS pending,
         ROUND(AVG(
           CASE WHEN j.completed_at IS NOT NULL AND j.accepted_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (j.completed_at - j.accepted_at)) / 3600
           END
         )::numeric, 1) AS avg_completion_hours
       FROM jobs j
       WHERE j.company_id = $1 ${clause}`,
            [companyId, ...params],
            [{}]
        );

        const byPriority = await safeQuery(
            `SELECT COALESCE(j.priority,'none') AS priority, COUNT(*) AS count
       FROM jobs j
       WHERE j.company_id = $1 ${clause}
       GROUP BY j.priority ORDER BY count DESC`,
            [companyId, ...params],
            []
        );

        const topEmployees = await safeQuery(
            `SELECT u.name, COUNT(*) AS completed_jobs
       FROM jobs j
       JOIN users u ON u.id = j.assigned_to
       WHERE j.status = 'completed'
         AND j.company_id = $1 ${clause}
       GROUP BY u.name
       ORDER BY completed_jobs DESC
       LIMIT 5`,
            [companyId, ...params],
            []
        );

        res.json({
            period,
            summary: summaryRows[0] || {},
            byPriority,
            topEmployees,
        });
    } catch (err) {
        console.error('❌ Reports/jobs error:', err.message);
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

/**
 * GET /api/reports/employees?period=week|month|quarter|year
 * Requires: advanced_reports (Basic+ plan)
 */
router.get('/employees', authenticateToken, loadPlan, requireFeature('advanced_reports'), async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        const companyId = req.user.companyId;
        const period = req.query.period || 'month';
        const { clause: attClause, params: attParams } = dateRangeFilter(period, 'a.date', 2);
        const { clause: jobClause, params: jobParams } = dateRangeFilter(period, 'j.created_at', 2);

        // Try joining employee_profiles — fall back to users-only if it doesn't exist
        const empRows = await safeQuery(
            `SELECT u.id, u.name, u.email,
              ep.department, ep.position,
              COALESCE(ep.status, 'active') AS employment_status
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.company_id = $1 AND u.role = 'employee'
       ORDER BY u.name`,
            [companyId],
            []
        );

        const results = await Promise.all(
            empRows.map(async (emp) => {
                const attRows = await safeQuery(
                    `SELECT
             COUNT(*)                                                       AS total_days,
             COUNT(CASE WHEN status = 'present' THEN 1 END)                AS present,
             ROUND(COALESCE(SUM(COALESCE(working_hours,0)), 0)::numeric,1) AS total_hours,
             COUNT(CASE WHEN COALESCE(is_late,false)=true THEN 1 END)      AS late_count
           FROM attendance a
           WHERE a.user_id = $1 ${attClause}`,
                    [emp.id, ...attParams],
                    [{ total_days: 0, present: 0, total_hours: 0, late_count: 0 }]
                );

                const jobRows = await safeQuery(
                    `SELECT
             COUNT(*)                                                              AS total,
             COUNT(CASE WHEN j.status = 'completed' THEN 1 END)                  AS completed,
             COUNT(CASE WHEN COALESCE(j.employee_status,'')='declined' THEN 1 END) AS declined
           FROM jobs j
           WHERE j.assigned_to = $1 ${jobClause}`,
                    [emp.id, ...jobParams],
                    [{ total: 0, completed: 0, declined: 0 }]
                );

                const attRow = attRows[0] || {};
                const attendanceRate = Number(attRow.total_days) > 0
                    ? Math.round((Number(attRow.present) / Number(attRow.total_days)) * 100)
                    : null;

                return { ...emp, attendance: { ...attRow, attendance_rate: attendanceRate }, jobs: jobRows[0] || {} };
            })
        );

        res.json({ period, employees: results });
    } catch (err) {
        console.error('❌ Reports/employees error:', err.message);
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

/**
 * GET /api/reports/materials?period=week|month|quarter|year
 * Requires: advanced_reports (Basic+ plan)
 */
router.get('/materials', authenticateToken, loadPlan, requireFeature('advanced_reports'), async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        const companyId = req.user.companyId;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'mr.created_at', 2);

        const summaryRows = await safeQuery(
            `SELECT
         COUNT(*)                                                  AS total,
         COUNT(CASE WHEN mr.status = 'approved' THEN 1 END)          AS approved,
         COUNT(CASE WHEN mr.status = 'rejected' THEN 1 END)          AS rejected,
         COUNT(CASE WHEN mr.status = 'pending'  THEN 1 END)          AS pending
       FROM material_requests mr
       WHERE mr.company_id = $1 ${clause}`,
            [companyId, ...params],
            [{}]
        );

        const topItems = await safeQuery(
            `SELECT mr.item_name, COUNT(*) AS request_count, SUM(mr.quantity) AS total_qty
       FROM material_requests mr
       WHERE mr.company_id = $1 ${clause}
       GROUP BY mr.item_name
       ORDER BY request_count DESC LIMIT 10`,
            [companyId, ...params],
            []
        );

        // Use requested_by_name if available (avoids JOIN type issues)
        const recent = await safeQuery(
            `SELECT mr.id, mr.item_name, mr.quantity, mr.status, mr.created_at,
              COALESCE(mr.requested_by_name, u.name, 'Unknown') AS requested_by
       FROM material_requests mr
       LEFT JOIN users u ON u.id::text = mr.requested_by::text
       WHERE mr.company_id = $1 ${clause}
       ORDER BY mr.created_at DESC LIMIT 20`,
            [companyId, ...params],
            []
        );

        res.json({ period, summary: summaryRows[0] || {}, topItems, recent });
    } catch (err) {
        console.error('❌ Reports/materials error:', err.message);
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

/**
 * GET /api/reports/inventory
 * Requires: advanced_reports (Basic+ plan)
 */
router.get('/inventory', authenticateToken, loadPlan, requireFeature('advanced_reports'), async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        const companyId = req.user.companyId;

        const summaryRows = await safeQuery(
            `SELECT
         COUNT(*) AS total_items,
         COUNT(CASE WHEN quantity = 0 THEN 1 END) AS low_stock_count,
         COUNT(CASE WHEN COALESCE(is_archived, false) = true THEN 1 END) AS archived_count,
         COUNT(DISTINCT COALESCE(category, 'Uncategorised')) AS category_count
       FROM inventory_items
       WHERE company_id = $1
         AND COALESCE(is_archived, false) = false`,
            [companyId],
            [{}]
        );

        const byCategory = await safeQuery(
            `SELECT COALESCE(category, 'Uncategorised') AS category,
              COUNT(*) AS item_count, SUM(quantity) AS total_qty
       FROM inventory_items
       WHERE company_id = $1
         AND COALESCE(is_archived, false) = false
       GROUP BY category ORDER BY item_count DESC`,
            [companyId],
            []
        );

        const lowStock = await safeQuery(
            `SELECT name, quantity,
              COALESCE(reorder_point, 0) AS reorder_point,
              COALESCE(unit, '') AS unit,
              COALESCE(category, 'Uncategorised') AS category
       FROM inventory_items
       WHERE company_id = $1
         AND COALESCE(is_archived, false) = false
         AND (quantity <= COALESCE(reorder_point, 5) OR quantity = 0)
       ORDER BY quantity ASC LIMIT 10`,
            [companyId],
            []
        );

        res.json({ summary: summaryRows[0] || {}, byCategory, lowStock });
    } catch (err) {
        console.error('❌ Reports/inventory error:', err.message);
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EMPLOYEE REPORTS (personal data only)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/reports/my-attendance?period=week|month|quarter|year
 */
router.get('/my-attendance', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'date', 2);

        const summaryRows = await safeQuery(
            `SELECT
         COUNT(*) AS total_days,
         COUNT(CASE WHEN status = 'present'  THEN 1 END) AS days_present,
         COUNT(CASE WHEN status = 'half_day' THEN 1 END) AS half_days,
         COUNT(CASE WHEN status = 'absent'   THEN 1 END) AS days_absent,
         COUNT(CASE WHEN COALESCE(is_late, false) = true THEN 1 END) AS late_count,
         ROUND(COALESCE(SUM(COALESCE(working_hours, 0)), 0)::numeric, 2) AS total_hours,
         ROUND(COALESCE(AVG(COALESCE(working_hours, 0)), 0)::numeric, 2) AS avg_hours
       FROM attendance
       WHERE user_id = $1 ${clause}`,
            [userId, ...params],
            [{}]
        );

        const history = await safeQuery(
            `SELECT id, date, check_in_time, check_out_time,
              COALESCE(working_hours, 0) AS working_hours,
              status, COALESCE(is_late, false) AS is_late, notes
       FROM attendance
       WHERE user_id = $1 ${clause}
       ORDER BY date DESC`,
            [userId, ...params],
            []
        );

        res.json({ period, summary: summaryRows[0] || {}, history });
    } catch (err) {
        console.error('❌ Reports/my-attendance error:', err.message);
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

/**
 * GET /api/reports/my-jobs?period=week|month|quarter|year
 */
router.get('/my-jobs', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'created_at', 2);

        const summaryRows = await safeQuery(
            `SELECT
         COUNT(*) AS total,
         COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed,
         COUNT(CASE WHEN status IN ('open','in_progress','active') THEN 1 END) AS in_progress,
         COUNT(CASE WHEN COALESCE(employee_status,'') = 'declined' THEN 1 END) AS declined,
         ROUND(AVG(COALESCE(progress, 0))::numeric, 0) AS avg_progress
       FROM jobs
       WHERE assigned_to = $1 ${clause}`,
            [userId, ...params],
            [{}]
        );

        const history = await safeQuery(
            `SELECT j.id, j.title, j.description, j.status,
              COALESCE(j.employee_status,'pending') AS employee_status,
              COALESCE(j.priority,'medium') AS priority,
              COALESCE(j.progress, 0) AS progress,
              j.created_at, j.accepted_at, j.completed_at
       FROM jobs j
       WHERE j.assigned_to = $1 ${clause}
       ORDER BY j.created_at DESC`,
            [userId, ...params],
            []
        );

        res.json({ period, summary: summaryRows[0] || {}, history });
    } catch (err) {
        console.error('❌ Reports/my-jobs error:', err.message);
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

/**
 * GET /api/reports/my-materials?period=week|month|quarter|year
 */
router.get('/my-materials', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'created_at', 2);

        const summaryRows = await safeQuery(
            `SELECT
         COUNT(*) AS total,
         COUNT(CASE WHEN status = 'approved' THEN 1 END) AS approved,
         COUNT(CASE WHEN status = 'rejected' THEN 1 END) AS rejected,
         COUNT(CASE WHEN status = 'pending'  THEN 1 END) AS pending
       FROM material_requests
       WHERE requested_by::text = $1::text ${clause}`,
            [userId, ...params],
            [{}]
        );

        const history = await safeQuery(
            `SELECT id, item_name, quantity,
              COALESCE(unit,'') AS unit, status,
              COALESCE(notes,'') AS notes, created_at
       FROM material_requests
       WHERE requested_by::text = $1::text ${clause}
       ORDER BY created_at DESC`,
            [userId, ...params],
            []
        );

        res.json({ period, summary: summaryRows[0] || {}, history });
    } catch (err) {
        console.error('❌ Reports/my-materials error:', err.message);
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

module.exports = router;
