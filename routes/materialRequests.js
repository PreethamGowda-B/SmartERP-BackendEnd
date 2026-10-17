const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification, createNotificationForOwners } = require('../utils/notificationHelpers');

router.use('/:requestId/purchase-bills', require('./materialPurchaseWorkflow'));

// ─── POST /api/material-requests ─────────────────────────────────────────────
// Create new material request (employee)
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { item_name, quantity, urgency, description, unit, job_id } = req.body;
        // Support both `id` (old) and `userId` (new) field names in JWT payload
        const userId = req.user.userId || req.user.id;

        if (!userId) {
            return res.status(401).json({ message: 'Invalid authentication token — missing user ID' });
        }

        if (!item_name || !item_name.trim()) {
            return res.status(400).json({ message: 'Item name is required' });
        }

        if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
            return res.status(400).json({ message: 'Valid quantity is required' });
        }

        if (!['employee', 'staff', 'technician'].includes(String(req.user.role || '').toLowerCase())) {
            return res.status(403).json({ message: 'Only employees can create material requests' });
        }

        // Get user name — cast both sides to text to support UUID and integer PKs
        const userResult = await pool.query(
            'SELECT name, email, company_id FROM users WHERE id::text = $1::text',
            [String(userId)]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userName = userResult.rows[0]?.name || userResult.rows[0]?.email || 'Unknown';
        const companyId = req.user.companyId || userResult.rows[0]?.company_id || null;
        if (job_id) {
            const job = await pool.query(
                'SELECT id FROM jobs WHERE id::text = $1::text AND company_id::text = $2::text',
                [String(job_id), String(companyId)]
            );
            if (!job.rows.length) return res.status(404).json({ message: 'Job not found for this company' });
        }

        const isValidUuid = (str) => typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
        const safeRequestedBy = isValidUuid(String(userId)) ? String(userId) : null;

        const result = await pool.query(
            `INSERT INTO material_requests 
       (item_name, quantity, unit, urgency, description, requested_by, requested_by_name, company_id, job_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING *`,
            [
                item_name.trim(),
                Number(quantity),
                typeof unit === 'string' ? unit.trim().slice(0, 50) || null : null,
                urgency || 'Medium',
                description?.trim() || null,
                safeRequestedBy,
                userName,
                companyId,
                job_id || null,
            ]
        );

        const createdRequest = result.rows[0];

        // Send notification to all owners about new material request
        try {
            await createNotificationForOwners({
                company_id: companyId,
                type: 'material_request_created',
                title: 'New Material Request',
                message: `${userName} requested ${quantity} ${item_name}`,
                priority: urgency === 'High' ? 'high' : 'medium',
                data: { request_id: createdRequest.id, item_name, quantity, urgency, url: '/owner/inventory?tab=materials' }
            });

            console.log(`✅ Notified owners about new material request`);
        } catch (notifErr) {
            console.error('❌ Failed to send material request creation notification:', notifErr);
        }

        res.status(201).json(createdRequest);
    } catch (err) {
        console.error('❌ Error creating material request:', err);
        res.status(500).json({
            message: 'Server error creating material request'
        });
    }
});

// ─── GET /api/material-requests ──────────────────────────────────────────────
// Get material requests (owner sees all, employee sees their own)
router.get('/', authenticateToken, async (req, res) => {
    try {
        // Support both id and userId field names in JWT payload (handle stale tokens)
        const userId = req.user.userId || req.user.id;
        const role = req.user.role;

        // Simple guard: if userId is completely missing, return 401
        if (!userId) {
            console.error('❌ GET /material-requests: missing userId from JWT', req.user);
            return res.status(401).json({
                message: 'Invalid authentication token — please log out and log back in.',
                hint: 'Your session token is missing the user ID. Re-login will fix this.'
            });
        }

        let companyId = req.user.companyId || req.user.company_id;
        if (!companyId) return res.status(403).json({ message: 'A company account is required to view material requests.' });

        let query;
        let params;

        if (role === 'owner' || role === 'admin') {
            // Owner sees all requests for their company
            const scopedCompanyId = companyId;
            query = `
                SELECT 
                    id, item_name, quantity, unit, urgency, description, status, purchase_status,
                    requested_by, requested_by_name, created_at, updated_at,
                    reviewed_by, reviewed_at,
                    (SELECT reviewer.name FROM users reviewer WHERE reviewer.id = material_requests.reviewed_by) AS reviewed_by_name
                FROM material_requests
                WHERE company_id::text = $1::text
                ORDER BY created_at DESC
            `;
            params = [String(scopedCompanyId)];
        } else {
            // Employees can only see their own requests in their current company.
            query = `
                SELECT 
                    id, item_name, quantity, unit, urgency, description, status, purchase_status,
                    requested_by, requested_by_name, created_at, updated_at,
                    reviewed_by, reviewed_at,
                    (SELECT reviewer.name FROM users reviewer WHERE reviewer.id = material_requests.reviewed_by) AS reviewed_by_name
                FROM material_requests
                WHERE requested_by::text = $1::text AND company_id::text = $2::text
                ORDER BY created_at DESC
            `;
            params = [String(userId), String(companyId)];
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Error fetching material requests:', err);
        // Return detailed error info so it shows in browser console (not just "Object")
        res.status(500).json({
            message: 'Server error fetching material requests'
        });
    }
});

// ─── PATCH /api/material-requests/:id/accept ─────────────────────────────────
// Accept material request (owner only)
router.patch('/:id/accept', authenticateToken, async (req, res) => {
    try {
        const role = req.user.role;
        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Only owners can accept requests' });
        }

        const { id } = req.params;
        const userId = req.user.userId || req.user.id;
        const companyId = req.user.companyId || req.user.company_id;
        if (!companyId || !userId) return res.status(403).json({ message: 'A company account is required to review requests.' });

        const result = await pool.query(
            `UPDATE material_requests 
       SET status = 'accepted', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id::text = $2::text AND status = 'pending' AND company_id::text = $3::text
       RETURNING *`,
            [userId, id, companyId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Request not found, already processed, or access denied' });
        }

        const request = result.rows[0];

        // Ensure we have company_id (fetch from DB if missing in token)
        // Send notification to employee
        if (companyId) {
            try {
                await createNotification({
                    user_id: request.requested_by,
                    company_id: companyId,
                    type: 'material_request',
                    title: 'Material Request Approved',
                    message: `Your request for ${request.item_name} has been approved`,
                    priority: 'medium',
                    data: { request_id: request.id, item_name: request.item_name, url: '/employee/materials' }
                });
                console.log(`✅ Notification sent for approved material request: ${request.item_name}`);
            } catch (notifErr) {
                console.error('❌ Failed to send material request notification:', notifErr);
            }
        } else {
            console.warn(`⚠️ Skipping notification: No company_id found for user ${userId}`);
        }

        res.json(request);
    } catch (err) {
        console.error('Error accepting material request:', err);
        res.status(500).json({ message: 'Server error accepting request' });
    }
});

// ─── PATCH /api/material-requests/:id/decline ────────────────────────────────
// Decline material request (owner only)
router.patch('/:id/decline', authenticateToken, async (req, res) => {
    try {
        const role = req.user.role;
        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Only owners can decline requests' });
        }

        const { id } = req.params;
        const userId = req.user.userId || req.user.id;
        let companyId = req.user.companyId || req.user.company_id;
        if (!companyId || !userId) return res.status(403).json({ message: 'A company account is required to review requests.' });

        const result = await pool.query(
            `UPDATE material_requests 
       SET status = 'declined', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id::text = $2::text AND status = 'pending' AND company_id::text = $3::text
       RETURNING *`,
            [userId, id, companyId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Request not found, already processed, or access denied' });
        }

        const request = result.rows[0];

        // Ensure we have company_id (fetch from DB if missing in token)
        // Send notification to employee
        if (companyId) {
            try {
                await createNotification({
                    user_id: request.requested_by,
                    company_id: companyId,
                    type: 'material_request',
                    title: 'Material Request Declined',
                    message: `Your request for ${request.item_name} has been declined`,
                    priority: 'low',
                    data: { request_id: request.id, item_name: request.item_name, url: '/employee/materials' }
                });
                console.log(`✅ Notification sent for declined material request: ${request.item_name}`);
            } catch (notifErr) {
                console.error('❌ Failed to send material request notification:', notifErr);
            }
        } else {
            console.warn(`⚠️ Skipping notification: No company_id found for user ${userId}`);
        }

        res.json(request);
    } catch (err) {
        console.error('Error declining material request:', err);
        res.status(500).json({ message: 'Server error declining request' });
    }
});

module.exports = router;
