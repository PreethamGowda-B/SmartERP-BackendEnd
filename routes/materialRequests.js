const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

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

        // Insert material request - use TEXT for requested_by to match integer user IDs
        const result = await pool.query(
            `INSERT INTO material_requests 
       (item_name, quantity, urgency, description, requested_by, requested_by_name, created_at) 
       VALUES ($1, $2, $3, $4, $5::text, $6, NOW()) 
       RETURNING *`,
            [
                item_name.trim(),
                parseInt(quantity),
                urgency || 'Medium',
                description?.trim() || null,
                userId.toString(),
                userName
            ]
        );

        res.status(201).json(result.rows[0]);
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

        let query;
        let params;

        if (role === 'owner' || role === 'admin') {
            // Owner sees all requests
            query = `SELECT * FROM material_requests ORDER BY created_at DESC`;
            params = [];
        } else {
            // Employee sees only their own requests - compare as text
            query = `SELECT * FROM material_requests WHERE requested_by = $1::text ORDER BY created_at DESC`;
            params = [userId.toString()];
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching material requests:', err);
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
       SET status = 'accepted', reviewed_by = $1::text, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
            [userId.toString(), id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Request not found or already processed' });
        }

        res.json(result.rows[0]);
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
       SET status = 'declined', reviewed_by = $1::text, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
            [userId.toString(), id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Request not found or already processed' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error declining material request:', err);
        res.status(500).json({ message: 'Server error declining request' });
    }
});

module.exports = router;
