const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── Startup: ensure all columns used by reports exist ───────────────────────

async function ensureReportColumns() {
    const columns = [
        // attendance
        { table: 'attendance', column: 'is_late', type: 'BOOLEAN DEFAULT false' },
        { table: 'attendance', column: 'working_hours', type: 'NUMERIC(5,2)' },
        { table: 'attendance', column: 'check_in_time', type: 'TIMESTAMPTZ' },
        { table: 'attendance', column: 'check_out_time', type: 'TIMESTAMPTZ' },
        { table: 'attendance', column: 'notes', type: 'TEXT' },
        // jobs
        { table: 'jobs', column: 'employee_status', type: "TEXT DEFAULT 'pending'" },
        { table: 'jobs', column: 'progress', type: 'INTEGER DEFAULT 0' },
        { table: 'jobs', column: 'accepted_at', type: 'TIMESTAMPTZ' },
        { table: 'jobs', column: 'completed_at', type: 'TIMESTAMPTZ' },
        { table: 'jobs', column: 'priority', type: 'TEXT' },
        { table: 'jobs', column: 'assigned_to', type: 'UUID' },
        { table: 'jobs', column: 'company_id', type: 'TEXT' },
        // material_requests
        { table: 'material_requests', column: 'company_id', type: 'TEXT' },
        { table: 'material_requests', column: 'unit', type: 'TEXT' },
        { table: 'material_requests', column: 'notes', type: 'TEXT' },
        // inventory_items
        { table: 'inventory_items', column: 'reorder_point', type: 'INTEGER DEFAULT 0' },
        { table: 'inventory_items', column: 'is_archived', type: 'BOOLEAN DEFAULT false' },
        { table: 'inventory_items', column: 'company_id', type: 'TEXT' },
        { table: 'inventory_items', column: 'unit', type: 'TEXT' },
        { table: 'inventory_items', column: 'category', type: 'TEXT' },
        // employee_profiles (in case table exists)
        { table: 'employee_profiles', column: 'department', type: 'TEXT' },
        { table: 'employee_profiles', column: 'position', type: 'TEXT' },
        { table: 'employee_profiles', column: 'status', type: "TEXT DEFAULT 'active'" },
    ];

    for (const { table, column, type } of columns) {
        try {
            await pool.query(`
        ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS ${column} ${type}
      `);
        } catch (e) {
            // Table might not exist — that's OK, just skip
        }
    }
    console.log('✅ Report columns ensured');
}

// Run after DB is ready
setTimeout(ensureReportColumns, 5000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a WHERE clause fragment + params for date range filtering.
 */
function dateRangeFilter(period, dateColumn, startIdx) {
    const now = new Date();
    let start;

    switch (period) {
        case 'week':
            start = new Date(now);
            start.setDate(now.getDate() - 7);
            break;
        case 'quarter':
            start = new Date(now);
            start.setMonth(now.getMonth() - 3);
            break;
        case 'year':
            start = new Date(now);
            start.setFullYear(now.getFullYear() - 1);
            break;
        case 'month':
        default:
            start = new Date(now);
            start.setMonth(now.getMonth() - 1);
            break;
    }

    return {
        clause: `AND ${dateColumn} >= $${startIdx} AND ${dateColumn} <= $${startIdx + 1}`,
        params: [start.toISOString(), now.toISOString()],
        nextIdx: startIdx + 2,
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
// OWNER REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/reports/attendance?period=week|month|quarter|year
 * All employees' attendance summary for the period (Owner only)
 */
router.get('/attendance', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const companyId = req.user.companyId;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'a.date', 2);

        // Per-employee attendance summary
        const result = await pool.query(
            `SELECT
         u.id,
         u.name,
         u.email,
         COUNT(a.id)                                              AS total_days,
         COUNT(CASE WHEN a.status = 'present' THEN 1 END)        AS days_present,
         COUNT(CASE WHEN a.status = 'half_day' THEN 1 END)       AS half_days,
         COUNT(CASE WHEN a.status = 'absent' THEN 1 END)         AS days_absent,
         COUNT(CASE WHEN a.is_late = true THEN 1 END)            AS late_count,
         ROUND(COALESCE(SUM(a.working_hours), 0)::numeric, 2)    AS total_hours,
         ROUND(COALESCE(AVG(a.working_hours), 0)::numeric, 2)    AS avg_hours_per_day
       FROM users u
       LEFT JOIN attendance a ON a.user_id = u.id ${clause}
       WHERE u.company_id = $1
         AND u.role = 'employee'
       GROUP BY u.id, u.name, u.email
       ORDER BY u.name ASC`,
            [companyId, ...params]
        );

        // Overall totals
        const totals = await pool.query(
            `SELECT
         COUNT(DISTINCT a.user_id)                               AS employees_with_records,
         COUNT(a.id)                                             AS total_records,
         COUNT(CASE WHEN a.status = 'present' THEN 1 END)       AS total_present,
         COUNT(CASE WHEN a.status = 'absent' THEN 1 END)        AS total_absent,
         ROUND(COALESCE(SUM(a.working_hours), 0)::numeric, 2)   AS total_hours
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       WHERE u.company_id = $1 ${clause}`,
            [companyId, ...params]
        );

        res.json({
            period,
            totals: totals.rows[0],
            employees: result.rows,
        });
    } catch (err) {
        console.error('❌ Reports/attendance error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * GET /api/reports/jobs?period=week|month|quarter|year
 * Job statistics for the period (Owner only)
 */
router.get('/jobs', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const companyId = req.user.companyId;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'created_at', 2);

        const summary = await pool.query(
            `SELECT
         COUNT(*)                                                         AS total,
         COUNT(CASE WHEN status = 'completed' THEN 1 END)                AS completed,
         COUNT(CASE WHEN status IN ('open','in_progress','active') THEN 1 END) AS in_progress,
         COUNT(CASE WHEN employee_status = 'declined' THEN 1 END)        AS declined,
         COUNT(CASE WHEN employee_status = 'pending' THEN 1 END)         AS pending,
         ROUND(AVG(
           CASE WHEN completed_at IS NOT NULL AND accepted_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (completed_at - accepted_at)) / 3600
           END
         )::numeric, 1)                                                  AS avg_completion_hours
       FROM jobs
       WHERE (company_id = $1 OR company_id IS NULL) ${clause}`,
            [companyId, ...params]
        );

        // Per-priority breakdown
        const byPriority = await pool.query(
            `SELECT priority, COUNT(*) AS count
       FROM jobs
       WHERE (company_id = $1 OR company_id IS NULL) ${clause}
       GROUP BY priority
       ORDER BY count DESC`,
            [companyId, ...params]
        );

        // Top employees by jobs completed
        const topEmployees = await pool.query(
            `SELECT
         u.name,
         COUNT(*) AS completed_jobs
       FROM jobs j
       JOIN users u ON u.id = j.assigned_to
       WHERE j.status = 'completed'
         AND (j.company_id = $1 OR j.company_id IS NULL) ${clause}
       GROUP BY u.name
       ORDER BY completed_jobs DESC
       LIMIT 5`,
            [companyId, ...params]
        );

        res.json({
            period,
            summary: summary.rows[0],
            byPriority: byPriority.rows,
            topEmployees: topEmployees.rows,
        });
    } catch (err) {
        console.error('❌ Reports/jobs error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * GET /api/reports/employees?period=week|month|quarter|year
 * Per-employee performance (Owner only)
 */
router.get('/employees', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const companyId = req.user.companyId;
        const period = req.query.period || 'month';
        const { clause: attClause, params: attParams } = dateRangeFilter(period, 'a.date', 2);
        const { clause: jobClause, params: jobParams } = dateRangeFilter(period, 'j.created_at', 2);

        const employees = await pool.query(
            `SELECT
         u.id,
         u.name,
         u.email,
         ep.department,
         ep.position,
         ep.status AS employment_status
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.company_id = $1 AND u.role = 'employee'
       ORDER BY u.name`,
            [companyId]
        );

        // For each employee, get attendance + job stats
        const results = await Promise.all(
            employees.rows.map(async (emp) => {
                const att = await pool.query(
                    `SELECT
             COUNT(*)                                              AS total_days,
             COUNT(CASE WHEN status = 'present' THEN 1 END)       AS present,
             ROUND(COALESCE(SUM(working_hours), 0)::numeric, 1)   AS total_hours,
             COUNT(CASE WHEN is_late = true THEN 1 END)           AS late_count
           FROM attendance a
           WHERE a.user_id = $1 ${attClause}`,
                    [emp.id, ...attParams]
                );

                const jobs = await pool.query(
                    `SELECT
             COUNT(*)                                                         AS total,
             COUNT(CASE WHEN j.status = 'completed' THEN 1 END)              AS completed,
             COUNT(CASE WHEN j.employee_status = 'declined' THEN 1 END)      AS declined
           FROM jobs j
           WHERE j.assigned_to = $1 ${jobClause}`,
                    [emp.id, ...jobParams]
                );

                const attRow = att.rows[0];
                const jobRow = jobs.rows[0];
                const attendanceRate = attRow.total_days > 0
                    ? Math.round((attRow.present / attRow.total_days) * 100)
                    : null;

                return { ...emp, attendance: { ...attRow, attendance_rate: attendanceRate }, jobs: jobRow };
            })
        );

        res.json({ period, employees: results });
    } catch (err) {
        console.error('❌ Reports/employees error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * GET /api/reports/materials?period=week|month|quarter|year
 * Material requests breakdown (Owner only)
 */
router.get('/materials', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const companyId = req.user.companyId;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'created_at', 2);

        const summary = await pool.query(
            `SELECT
         COUNT(*)                                                 AS total,
         COUNT(CASE WHEN status = 'approved' THEN 1 END)         AS approved,
         COUNT(CASE WHEN status = 'rejected' THEN 1 END)         AS rejected,
         COUNT(CASE WHEN status = 'pending' THEN 1 END)          AS pending
       FROM material_requests
       WHERE (company_id = $1 OR company_id IS NULL) ${clause}`,
            [companyId, ...params]
        );

        // Most requested items
        const topItems = await pool.query(
            `SELECT item_name, COUNT(*) AS request_count, SUM(quantity) AS total_qty
       FROM material_requests
       WHERE (company_id = $1 OR company_id IS NULL) ${clause}
       GROUP BY item_name
       ORDER BY request_count DESC
       LIMIT 10`,
            [companyId, ...params]
        );

        // Recent requests
        const recent = await pool.query(
            `SELECT mr.id, mr.item_name, mr.quantity, mr.status, mr.created_at, u.name AS requested_by
       FROM material_requests mr
       JOIN users u ON u.id = mr.requested_by
       WHERE (mr.company_id = $1 OR mr.company_id IS NULL) ${clause}
       ORDER BY mr.created_at DESC
       LIMIT 20`,
            [companyId, ...params]
        );

        res.json({ period, summary: summary.rows[0], topItems: topItems.rows, recent: recent.rows });
    } catch (err) {
        console.error('❌ Reports/materials error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * GET /api/reports/inventory
 * Inventory snapshot (Owner only) — no period filter, it's current state
 */
router.get('/inventory', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const companyId = req.user.companyId;

        const summary = await pool.query(
            `SELECT
         COUNT(*)                                                          AS total_items,
         COUNT(CASE WHEN quantity <= COALESCE(reorder_point, 0) AND quantity = 0 THEN 1 END) AS low_stock_count,
         COUNT(CASE WHEN COALESCE(is_archived, false) = true THEN 1 END)  AS archived_count,
         COUNT(DISTINCT category)                                          AS category_count
       FROM inventory_items
       WHERE (company_id = $1 OR company_id IS NULL)
         AND COALESCE(is_archived, false) = false`,
            [companyId]
        );

        const byCategory = await pool.query(
            `SELECT COALESCE(category, 'Uncategorised') AS category, COUNT(*) AS item_count, SUM(quantity) AS total_qty
       FROM inventory_items
       WHERE (company_id = $1 OR company_id IS NULL)
         AND COALESCE(is_archived, false) = false
       GROUP BY category
       ORDER BY item_count DESC`,
            [companyId]
        );

        const lowStock = await pool.query(
            `SELECT name, quantity, COALESCE(reorder_point, 0) AS reorder_point, unit, COALESCE(category, 'Uncategorised') AS category
       FROM inventory_items
       WHERE (company_id = $1 OR company_id IS NULL)
         AND COALESCE(is_archived, false) = false
         AND (quantity <= COALESCE(reorder_point, 0) OR quantity = 0)
       ORDER BY quantity ASC
       LIMIT 10`,
            [companyId]
        );

        res.json({
            summary: summary.rows[0],
            byCategory: byCategory.rows,
            lowStock: lowStock.rows,
        });
    } catch (err) {
        console.error('❌ Reports/inventory error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EMPLOYEE REPORTS (personal data only)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/reports/my-attendance?period=week|month|quarter|year
 * Personal attendance history + summary (Employee)
 */
router.get('/my-attendance', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'date', 2);

        const summary = await pool.query(
            `SELECT
         COUNT(*)                                              AS total_days,
         COUNT(CASE WHEN status = 'present' THEN 1 END)       AS days_present,
         COUNT(CASE WHEN status = 'half_day' THEN 1 END)      AS half_days,
         COUNT(CASE WHEN status = 'absent' THEN 1 END)        AS days_absent,
         COUNT(CASE WHEN is_late = true THEN 1 END)           AS late_count,
         ROUND(COALESCE(SUM(working_hours), 0)::numeric, 2)   AS total_hours,
         ROUND(COALESCE(AVG(working_hours), 0)::numeric, 2)   AS avg_hours
       FROM attendance
       WHERE user_id = $1 ${clause}`,
            [userId, ...params]
        );

        const history = await pool.query(
            `SELECT
         id, date, check_in_time, check_out_time,
         working_hours, status, is_late, notes
       FROM attendance
       WHERE user_id = $1 ${clause}
       ORDER BY date DESC`,
            [userId, ...params]
        );

        res.json({
            period,
            summary: summary.rows[0],
            history: history.rows,
        });
    } catch (err) {
        console.error('❌ Reports/my-attendance error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * GET /api/reports/my-jobs?period=week|month|quarter|year
 * Personal job history (Employee)
 */
router.get('/my-jobs', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'created_at', 2);

        const summary = await pool.query(
            `SELECT
         COUNT(*)                                                          AS total,
         COUNT(CASE WHEN status = 'completed' THEN 1 END)                 AS completed,
         COUNT(CASE WHEN status IN ('open','in_progress','active') THEN 1 END) AS in_progress,
         COUNT(CASE WHEN employee_status = 'declined' THEN 1 END)         AS declined,
         ROUND(AVG(progress)::numeric, 0)                                 AS avg_progress
       FROM jobs
       WHERE assigned_to = $1 ${clause}`,
            [userId, ...params]
        );

        const history = await pool.query(
            `SELECT
         id, title, description, status, employee_status,
         priority, progress, created_at, accepted_at, completed_at
       FROM jobs
       WHERE assigned_to = $1 ${clause}
       ORDER BY created_at DESC`,
            [userId, ...params]
        );

        res.json({ period, summary: summary.rows[0], history: history.rows });
    } catch (err) {
        console.error('❌ Reports/my-jobs error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * GET /api/reports/my-materials?period=week|month|quarter|year
 * Personal material request history (Employee)
 */
router.get('/my-materials', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const period = req.query.period || 'month';
        const { clause, params } = dateRangeFilter(period, 'created_at', 2);

        const summary = await pool.query(
            `SELECT
         COUNT(*)                                                  AS total,
         COUNT(CASE WHEN status = 'approved' THEN 1 END)          AS approved,
         COUNT(CASE WHEN status = 'rejected' THEN 1 END)          AS rejected,
         COUNT(CASE WHEN status = 'pending' THEN 1 END)           AS pending
       FROM material_requests
       WHERE requested_by = $1 ${clause}`,
            [userId, ...params]
        );

        const history = await pool.query(
            `SELECT id, item_name, quantity, unit, status, notes, created_at
       FROM material_requests
       WHERE requested_by = $1 ${clause}
       ORDER BY created_at DESC`,
            [userId, ...params]
        );

        res.json({ period, summary: summary.rows[0], history: history.rows });
    } catch (err) {
        console.error('❌ Reports/my-materials error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
