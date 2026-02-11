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

        // Get budget utilization (simplified - no budget column exists yet)
        const budgetResult = {
            rows: [{ total_budget: 0, total_spent: 0 }]
        };

        const totalBudget = 1; // Default to avoid division by zero
        const totalSpent = 0;
        const budgetUtilization = 0;

        // Get active projects (top 3) - only use existing columns
        const projectsResult = await pool.query(
            `SELECT 
                id, title, description, status, priority, progress,
                created_at, assigned_to
             FROM jobs 
             WHERE status IN ('active', 'in_progress')
             ${companyId ? 'AND company_id = $1' : ''}
             ORDER BY created_at DESC
             LIMIT 3`,
            companyId ? [companyId] : []
        );

        // Add mock spent/budget for frontend compatibility
        const activeProjects = projectsResult.rows.map(job => ({
            ...job,
            budget: 0,
            spent: 0
        }));

        res.json({
            activeJobs: parseInt(jobsResult.rows[0].count),
            activeEmployees: parseInt(employeesResult.rows[0].count),
            todayAttendance: parseInt(attendanceResult.rows[0].count),
            budgetUtilization: budgetUtilization.toFixed(1),
            totalBudget,
            totalSpent,
            activeProjects
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
