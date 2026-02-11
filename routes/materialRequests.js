const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification } = require('../utils/notificationHelpers');

// ─── POST /api/material-requests ─────────────────────────────────────────────
// Create new material request (employee)
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { item_name, quantity, urgency, description } = req.body;
        const userId = req.user.userId || req.user.id;

        if (!item_name || !item_name.trim()) {
            return res.status(400).json({ message: 'Item name is required' });
        }

        if (!quantity || quantity <= 0) {
            return res.status(400).json({ message: 'Valid quantity is required' });
        }

        // Get user name
        const userResult = await pool.query(
            'SELECT name, email FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userName = userResult.rows[0]?.name || userResult.rows[0]?.email || 'Unknown';

        const result = await pool.query(
            `INSERT INTO material_requests 
       (item_name, quantity, urgency, description, requested_by, requested_by_name, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) 
       RETURNING *`,
            [
                item_name.trim(),
                parseInt(quantity),
                urgency || 'Medium',
                description?.trim() || null,
                userId,
                userName
            ]
        );

        const createdRequest = result.rows[0];

        // Send notification to all owners about new material request
        try {
            const companyId = req.user.companyId;

            // Get all owners
            const ownersResult = await pool.query(
                `SELECT id FROM users WHERE role IN ('owner', 'admin')
                 ${companyId && companyId !== '00000000-0000-0000-0000-000000000000' ? 'AND (company_id = $1 OR company_id IS NULL)' : ''}`,
                companyId && companyId !== '00000000-0000-0000-0000-000000000000' ? [companyId] : []
            );

            // Send notification to each owner
            for (const owner of ownersResult.rows) {
                await createNotification({
                    user_id: owner.id,
                    company_id: companyId,
                    type: 'material_request_created',
                    title: 'New Material Request',
                    message: `${userName} requested ${quantity} ${item_name}`,
                    priority: urgency === 'High' ? 'high' : 'medium',
                    data: { request_id: createdRequest.id, item_name, quantity, urgency }
                });
            }
            console.log(`✅ Notified ${ownersResult.rows.length} owners about new material request`);
        } catch (notifErr) {
            console.error('❌ Failed to send material request creation notification:', notifErr);
        }

        res.status(201).json(createdRequest);
    } catch (err) {
        console.error('Error creating material request:', err);
        res.status(500).json({ message: 'Server error creating material request' });
    }
});

// ─── GET /api/material-requests ──────────────────────────────────────────────
// Get material requests (owner sees all, employee sees their own)
router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const role = req.user.role;

        console.log('🔍 Fetching material requests for:', { userId, role, userIdType: typeof userId });

        let query;
        let params;

        if (role === 'owner' || role === 'admin') {
            // Owner sees all requests
            query = `SELECT * FROM material_requests ORDER BY created_at DESC`;
            params = [];
        } else {
            // Employee sees only their own requests
            query = `SELECT * FROM material_requests WHERE requested_by = $1 ORDER BY created_at DESC`;
            params = [userId];
        }

        console.log('📝 Query:', query);
        console.log('📝 Params:', params);

        const result = await pool.query(query, params);
        console.log(`✅ Found ${result.rows.length} material requests for user ${userId}`);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Error fetching material requests:', err);
        console.error('❌ Error details:', {
            message: err.message,
            code: err.code,
            detail: err.detail
        });
        res.status(500).json({ message: 'Server error fetching material requests' });
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

        const result = await pool.query(
            `UPDATE material_requests 
       SET status = 'accepted', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
            [userId, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Request not found or already processed' });
        }

        const request = result.rows[0];

        // Ensure we have company_id (fetch from DB if missing in token)
        let companyId = req.user.companyId;
        if (!companyId) {
            const userRes = await pool.query('SELECT company_id FROM users WHERE id = $1', [userId]);
            if (userRes.rows.length > 0) {
                companyId = userRes.rows[0].company_id;
            }
        }

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
                    data: { request_id: request.id, item_name: request.item_name }
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

        const result = await pool.query(
            `UPDATE material_requests 
       SET status = 'declined', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
            [userId, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Request not found or already processed' });
        }

        const request = result.rows[0];

        // Ensure we have company_id (fetch from DB if missing in token)
        let companyId = req.user.companyId;
        if (!companyId) {
            const userRes = await pool.query('SELECT company_id FROM users WHERE id = $1', [userId]);
            if (userRes.rows.length > 0) {
                companyId = userRes.rows[0].company_id;
            }
        }

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
                    data: { request_id: request.id, item_name: request.item_name }
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
