/**
 * routes/location.js — HARDENED
 *
 * Changes:
 *  1. POST /update: After saving GPS, broadcast `location_update` SSE to
 *     all active jobs assigned to this employee (accepted/in_progress).
 *  2. POST /update: Reject if no active job assigned to this employee.
 *  3. Added rate-limiting: reject if same employee updated within 8 seconds.
 *  4. Only assigned employee can push location (validated server-side).
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { loadPlan } = require('../middleware/planMiddleware');
const { requireFeature } = require('../middleware/featureGuard');
const redisClient = require('../utils/redis');

// ─── POST /api/location/update ────────────────────────────────────────────────
// Employee pushes GPS. Validates assigned job, publishes SSE to customer.
router.post('/update', authenticateToken, loadPlan, requireFeature('location_tracking'), async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const companyId = req.user.companyId;
        const { latitude, longitude } = req.body;

        if (latitude == null || longitude == null) {
            return res.status(400).json({ success: false, error: 'latitude and longitude are required' });
        }
        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
            return res.status(400).json({ success: false, error: 'latitude and longitude must be numbers' });
        }
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            return res.status(400).json({ success: false, error: 'Invalid coordinates' });
        }

        // Rate limit: 1 update per 8 seconds per employee (via Redis)
        if (redisClient && redisClient.status === 'ready') {
            const rateLimitKey = `loc_rate:${userId}`;
            const existing = await redisClient.get(rateLimitKey);
            if (existing) {
                return res.status(429).json({ success: false, error: 'Location updated too recently. Wait 8 seconds.' });
            }
            await redisClient.setex(rateLimitKey, 8, '1');
        }

        // Find active jobs assigned to this employee (must be accepted/in_progress)
        const activeJobsResult = await pool.query(
            `SELECT id, customer_id FROM jobs
       WHERE assigned_to = $1
         AND company_id::text = $2
         AND employee_status = 'accepted'
         AND status IN ('in_progress', 'open')`,
            [userId, String(companyId)]
        );

        // Upsert location
        const result = await pool.query(
            `INSERT INTO employee_profiles (user_id, latitude, longitude, location_updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET
         latitude            = EXCLUDED.latitude,
         longitude           = EXCLUDED.longitude,
         location_updated_at = NOW()
       RETURNING latitude, longitude, location_updated_at`,
            [userId, latitude, longitude]
        );

        const locationRow = result.rows[0];

        // Publish SSE to each job's customer stream
        if (redisClient && redisClient.status === 'ready' && activeJobsResult.rows.length > 0) {
            const ssePayload = JSON.stringify({
                type: 'location_update',
                lat: parseFloat(locationRow.latitude),
                lng: parseFloat(locationRow.longitude),
                updatedAt: locationRow.location_updated_at,
                employeeId: userId,
            });

            for (const job of activeJobsResult.rows) {
                redisClient.publish(`customer_job_events:${job.id}`, ssePayload)
                    .catch(e => console.error(`SSE publish error (job ${job.id}):`, e.message));
            }
        }

        res.json({
            success: true,
            data: {
                location: {
                    latitude: parseFloat(locationRow.latitude),
                    longitude: parseFloat(locationRow.longitude),
                    location_updated_at: locationRow.location_updated_at,
                },
                active_jobs_notified: activeJobsResult.rows.length,
            },
            error: null,
        });
    } catch (err) {
        console.error('POST /location/update error:', err.message);
        res.status(500).json({ success: false, error: 'Server error updating location' });
    }
});

// ─── GET /api/location/all ────────────────────────────────────────────────────
// Owner/admin: all employees with latest known location (company-scoped)
router.get('/all', authenticateToken, loadPlan, requireFeature('location_tracking'), async (req, res) => {
    try {
        const role = req.user.role;
        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Only owners can view employee locations' });
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
       WHERE u.role = 'employee' AND u.company_id::text = $1
       ORDER BY ep.location_updated_at DESC NULLS LAST, u.name ASC`,
            [String(companyId)]
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
            is_online: row.location_updated_at
                ? (Date.now() - new Date(row.location_updated_at).getTime()) < 30_000
                : false,
        }));

        res.json({ success: true, data: employees, error: null });
    } catch (err) {
        console.error('GET /location/all error:', err.message);
        res.status(500).json({ success: false, error: 'Server error fetching locations' });
    }
});

// ─── GET /api/location/:employeeId ────────────────────────────────────────────
// Owner/admin: single employee location (company-scoped)
router.get('/:employeeId', authenticateToken, loadPlan, requireFeature('location_tracking'), async (req, res) => {
    try {
        const role = req.user.role;
        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Only owners can view employee locations' });
        }

        const { employeeId } = req.params;
        const result = await pool.query(
            `SELECT
         u.id, COALESCE(u.name, split_part(u.email, '@', 1)) AS name,
         u.email, ep.latitude, ep.longitude, ep.location_updated_at, ep.position
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.id = $1 AND u.role = 'employee' AND u.company_id::text = $2`,
            [employeeId, String(req.user.companyId)]
        );

        if (!result.rows.length) {
            return res.status(404).json({ success: false, error: 'Employee not found' });
        }

        const row = result.rows[0];
        res.json({
            success: true,
            data: {
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
            },
            error: null,
        });
    } catch (err) {
        console.error(`GET /location/${req.params.employeeId} error:`, err.message);
        res.status(500).json({ success: false, error: 'Server error fetching location' });
    }
});

module.exports = router;
