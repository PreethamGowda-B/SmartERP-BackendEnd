const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/dashboard/owner/metrics ────────────────────────────────────────
// Get aggregated metrics for owner dashboard
router.get('/owner/metrics', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const companyId = req.user.companyId;

        // Get active jobs count
        const jobsResult = await pool.query(
            `SELECT COUNT(*) as count 
             FROM jobs 
             WHERE status IN ('active', 'in_progress', 'open')
             ${companyId ? 'AND company_id = $1' : ''}`,
            companyId ? [companyId] : []
        );

        // Get active employees count
        const employeesResult = await pool.query(
            `SELECT COUNT(*) as count 
             FROM users 
             WHERE role = 'employee' 
             AND (is_active = true OR is_active IS NULL)
             ${companyId ? 'AND company_id = $1' : ''}`,
            companyId ? [companyId] : []
        );

        // Get today's attendance
        const today = new Date().toISOString().split('T')[0];
        const attendanceResult = await pool.query(
            `SELECT COUNT(DISTINCT user_id) as count 
             FROM attendance 
             WHERE date = $1
             ${companyId ? 'AND company_id = $2' : ''}`,
            companyId ? [today, companyId] : [today]
        );

        // Get budget utilization
        const budgetResult = await pool.query(
            `SELECT 
                COALESCE(SUM(budget), 0) as total_budget,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN budget ELSE 0 END), 0) as total_spent
             FROM jobs
             ${companyId ? 'WHERE company_id = $1' : ''}`,
            companyId ? [companyId] : []
        );

        const totalBudget = parseFloat(budgetResult.rows[0].total_budget) || 1;
        const totalSpent = parseFloat(budgetResult.rows[0].total_spent) || 0;
        const budgetUtilization = (totalSpent / totalBudget) * 100;

        // Get active projects (top 3)
        const projectsResult = await pool.query(
            `SELECT 
                id, title, client, priority, budget, status,
                COALESCE((SELECT SUM(amount) FROM expenses WHERE job_id = jobs.id), 0) as spent
             FROM jobs 
             WHERE status IN ('active', 'in_progress')
             ${companyId ? 'AND company_id = $1' : ''}
             ORDER BY created_at DESC
             LIMIT 3`,
            companyId ? [companyId] : []
        );

        res.json({
            activeJobs: parseInt(jobsResult.rows[0].count),
            activeEmployees: parseInt(employeesResult.rows[0].count),
            todayAttendance: parseInt(attendanceResult.rows[0].count),
            budgetUtilization: budgetUtilization.toFixed(1),
            totalBudget,
            totalSpent,
            activeProjects: projectsResult.rows
        });
    } catch (err) {
        console.error('Error fetching owner dashboard metrics:', err);
        res.status(500).json({ message: 'Server error fetching dashboard metrics' });
    }
});

// ─── GET /api/dashboard/owner/recent-activity ────────────────────────────────
// Get recent activity for owner dashboard (from notifications)
router.get('/owner/recent-activity', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const companyId = req.user.companyId;

        // Get recent notifications (last 10)
        const result = await pool.query(
            `SELECT id, type, title, message, priority, created_at
             FROM notifications
             WHERE user_id = $1
             ${companyId ? 'AND company_id = $2' : ''}
             ORDER BY created_at DESC
             LIMIT 10`,
            companyId ? [userId, companyId] : [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching recent activity:', err);
        res.status(500).json({ message: 'Server error fetching recent activity' });
    }
});

module.exports = router;
