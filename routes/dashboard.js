const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { cacheMiddleware } = require('../middleware/cache');
const AttendancePolicy = require('../services/attendancePolicyService');

// ─── GET /api/dashboard/owner/metrics ────────────────────────────────────────
router.get('/owner/metrics', authenticateToken, cacheMiddleware(300), async (req, res) => {
    // 🛡️ H-1 Fix: Server-side authorization check (owner / super_admin only)
    if (req.user.role !== 'owner' && req.user.role !== 'super_admin') {
        return res.status(403).json({ 
            message: "Access Denied: Owner administrative privileges required to view company financial metrics." 
        });
    }

    try {
        const companyId = req.user.companyId;
        const policy = companyId ? await AttendancePolicy.getCompanyPolicy(companyId, pool) : AttendancePolicy.DEFAULT_ATTENDANCE_POLICY;
        const today = AttendancePolicy.localDate(new Date(), policy.timezone);

        // 🚀 Parallelize all 4 independent queries for sub-second dashboard load
        const [jobsResult, employeesResult, attResult, projectsResult] = await Promise.all([
            pool.query(
                `SELECT COUNT(*) AS count
                 FROM jobs
                 WHERE status IN ('active', 'in_progress', 'open', 'accepted')
                   AND company_id = $1`,
                [companyId]
            ),
            pool.query(
                `SELECT COUNT(*) AS count
                 FROM users
                 WHERE role = 'employee'
                   AND company_id = $1`,
                [companyId]
            ),
            pool.query(
                `SELECT COUNT(DISTINCT user_id) AS count
                 FROM attendance
                 WHERE date = $1
                   AND company_id = $2
                   AND status IN ('present', 'half_day', 'late')`,
                [today, companyId]
            ),
            pool.query(
                `SELECT j.id, j.title, j.description, j.status,
                  COALESCE(j.employee_status, 'pending') AS employee_status,
                  COALESCE(j.priority, 'medium') AS priority,
                  COALESCE(j.progress, 0) AS progress,
                  j.created_at, j.assigned_to,
                  u.name AS assignee_name
                 FROM jobs j
                 LEFT JOIN users u ON u.id = j.assigned_to
                 WHERE (
                     j.status IN ('active', 'in_progress', 'open')
                     OR COALESCE(j.employee_status, '') = 'accepted'
                   )
                   AND j.company_id = $1
                 ORDER BY j.created_at DESC
                 LIMIT 5`,
                [companyId]
            ),
        ]);

        res.json({
            activeJobs: parseInt(jobsResult.rows[0]?.count || 0),
            activeEmployees: parseInt(employeesResult.rows[0]?.count || 0),
            todayAttendance: parseInt(attResult.rows[0]?.count || 0),
            budgetUtilization: '0.0',
            totalBudget: 0,
            totalSpent: 0,
            activeProjects: projectsResult.rows,
        });
    } catch (err) {
        console.error('❌ Dashboard metrics error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ─── GET /api/dashboard/owner/recent-activity ────────────────────────────────
router.get('/owner/recent-activity', authenticateToken, cacheMiddleware(60), async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const companyId = req.user.companyId;

        // Pull notifications targeted to this owner or company-wide notifications (excluding other users' private reminders)
        let activities = [];
        try {
            const notifResult = await pool.query(
                `SELECT id, type, title, message, priority, created_at
                 FROM notifications
                 WHERE (user_id = $1 OR (company_id = $2 AND user_id IS NULL))
                 ORDER BY created_at DESC LIMIT 25`,
                [userId, companyId]
            );
            
            // Deduplicate consecutive or identical events (e.g. repeated creation bursts)
            const seen = new Set();
            activities = (notifResult.rows || []).filter(item => {
                const cleanTitle = (item.title || '').trim().toLowerCase();
                const cleanMsg = (item.message || '').trim().toLowerCase();
                const key = `${cleanTitle}:${cleanMsg}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).slice(0, 10);
        } catch (e) { /* notifications table may vary */ }

        // If no notifications, synthesize from recent job + attendance events concurrently
        if (activities.length === 0) {
            const [recentJobs, recentAttendance] = await Promise.all([
                pool.query(
                    `SELECT id, title, status, created_at, 'job' AS type, priority
                     FROM jobs
                     WHERE company_id = $1
                     ORDER BY created_at DESC LIMIT 5`,
                    [companyId]
                ),
                pool.query(
                    `SELECT a.id, u.name, a.status, a.date, a.created_at
                     FROM attendance a
                     JOIN users u ON u.id = a.user_id AND u.company_id::text = a.company_id::text
                     WHERE u.company_id = $1
                     ORDER BY a.created_at DESC LIMIT 5`,
                    [companyId]
                ),
            ]);

            activities = [
                ...recentJobs.rows.map(j => ({
                    id: j.id,
                    type: 'job',
                    title: `Job: ${j.title}`,
                    message: `Status: ${j.status}`,
                    priority: j.priority || 'medium',
                    created_at: j.created_at,
                })),
                ...recentAttendance.rows.map(a => ({
                    id: `att-${a.id}`,
                    type: 'attendance',
                    title: `${a.name} marked attendance`,
                    message: `Status: ${a.status} on ${a.date}`,
                    priority: 'low',
                    created_at: a.created_at,
                })),
            ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .slice(0, 10);
        }

        res.json(activities);
    } catch (err) {
        console.error('❌ Dashboard recent-activity error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
