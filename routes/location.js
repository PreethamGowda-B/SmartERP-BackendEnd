const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');
const { requireFeature } = require('../middleware/featureGuard');

// ─── Auto-migrate location columns on first load ──────────────────────────────
// ─── Auto-migrate location columns and constraints on first load ──────────────


// ─── POST /api/location/update ────────────────────────────────────────────────
// Employee pushes their current GPS coordinates
// Gated: Basic plan or higher (location_tracking feature)
router.post('/update', authenticateToken, loadPlan, requireFeature('location_tracking'), async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const { latitude, longitude } = req.body;

        if (latitude == null || longitude == null) {
            return res.status(400).json({ message: 'latitude and longitude are required' });
        }

        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
            return res.status(400).json({ message: 'latitude and longitude must be numbers' });
        }

        // Upsert: if employee_profiles row exists, update; otherwise insert
        const result = await pool.query(
            `INSERT INTO employee_profiles (user_id, latitude, longitude, location_updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET
         latitude             = EXCLUDED.latitude,
         longitude            = EXCLUDED.longitude,
         location_updated_at  = NOW()
       RETURNING latitude, longitude, location_updated_at`,
            [userId, latitude, longitude]
        );

        res.json({
            message: 'Location updated',
            location: result.rows[0],
        });
    } catch (err) {
        console.error('POST /location/update error:', err.message);
        res.status(500).json({ message: 'Server error updating location' });
    }
});

// ─── GET /api/location/all ────────────────────────────────────────────────────
// Owner/admin: get all employees with their latest known location
// Gated: Basic plan or higher (location_tracking feature)
router.get('/all', authenticateToken, loadPlan, requireFeature('location_tracking'), async (req, res) => {
    try {
        const role = req.user.role;
        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Only owners can view employee locations' });
        }

        const companyId = req.user.companyId;

        const result = await pool.query(
            `SELECT
         u.id,
         COALESCE(u.name, split_part(u.email, '@', 1)) AS name,
         u.email,
         ep.latitude,
         ep.longitude,
         ep.location_updated_at,
         ep.position,
         ep.department,
         ep.is_active
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.role = 'employee' AND u.company_id = $1
       ORDER BY ep.location_updated_at DESC NULLS LAST, u.name ASC`,
            [companyId]
        );

        const employees = result.rows.map(row => ({
            id: row.id,
            name: row.name,
            email: row.email,
            position: row.position || 'Employee',
            department: row.department || null,
            is_active: row.is_active !== false,
            latitude: row.latitude ? parseFloat(row.latitude) : null,
            longitude: row.longitude ? parseFloat(row.longitude) : null,
            location_updated_at: row.location_updated_at || null,
            // Online = updated within last 30 seconds
            is_online: row.location_updated_at
                ? (Date.now() - new Date(row.location_updated_at).getTime()) < 30_000
                : false,
        }));

        res.json(employees);
    } catch (err) {
        console.error('GET /location/all error:', err.message);
        res.status(500).json({ message: 'Server error fetching locations' });
    }
});

// ─── GET /api/location/:employeeId ────────────────────────────────────────────
// Owner/admin: get a single employee's latest location
router.get('/:employeeId', authenticateToken, loadPlan, requireFeature('location_tracking'), async (req, res) => {
    try {
        const role = req.user.role;
        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Only owners can view employee locations' });
        }

        const { employeeId } = req.params;

        const result = await pool.query(
            `SELECT
         u.id,
         COALESCE(u.name, split_part(u.email, '@', 1)) AS name,
         u.email,
         ep.latitude,
         ep.longitude,
         ep.location_updated_at,
         ep.position
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.id = $1 AND u.role = 'employee' AND u.company_id = $2`,
            [employeeId, req.user.companyId]
        );

        if (!result.rows.length) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const row = result.rows[0];
        res.json({
            id: row.id,
            name: row.name,
            email: row.email,
            position: row.position || 'Employee',
            latitude: row.latitude ? parseFloat(row.latitude) : null,
            longitude: row.longitude ? parseFloat(row.longitude) : null,
            location_updated_at: row.location_updated_at || null,
            is_online: row.location_updated_at
                ? (Date.now() - new Date(row.location_updated_at).getTime()) < 30_000
                : false,
        });
    } catch (err) {
        console.error(`GET /location/${req.params.employeeId} error:`, err.message);
        res.status(500).json({ message: 'Server error fetching location' });
    }
});

module.exports = router;
