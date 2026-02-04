const express = require('express');
const router = express.Router();
const multer = require('multer');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { storage } = require('../config/cloudinary');

// Configure multer with Cloudinary storage
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// ─── POST /api/inventory ─────────────────────────────────────────────────────
// Create inventory item (both owner and employee can add)
router.post('/', authenticateToken, upload.single('image'), async (req, res) => {
    try {
        const { name, description, quantity } = req.body;
        const userId = req.user.userId;

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Item name is required' });
        }

        // Get image URL from Cloudinary if file was uploaded
        let imageUrl = null;
        if (req.file) {
            imageUrl = req.file.path; // Cloudinary URL
        }

        // Get employee name
        const userResult = await pool.query(
            'SELECT name, email FROM users WHERE id = $1',
            [userId]
        );
        const employeeName = userResult.rows[0]?.name || userResult.rows[0]?.email || 'Unknown';

        // Insert inventory item
        const result = await pool.query(
            `INSERT INTO inventory_items 
       (name, description, quantity, image_url, created_by, employee_name, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) 
       RETURNING *`,
            [
                name.trim(),
                description?.trim() || null,
                parseInt(quantity) || 0,
                imageUrl,
                userId,
                employeeName
            ]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating inventory item:', err);
        res.status(500).json({ message: 'Server error creating inventory item' });
    }
});

// ─── GET /api/inventory ──────────────────────────────────────────────────────
// Get all inventory items
router.get('/', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT 
        id,
        name,
        description,
        quantity,
        image_url,
        employee_name,
        office_name,
        created_by,
        created_at
       FROM inventory_items 
       ORDER BY created_at DESC`
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching inventory items:', err);
        res.status(500).json({ message: 'Server error fetching inventory items' });
    }
});

// ─── DELETE /api/inventory/:id ───────────────────────────────────────────────
// Delete inventory item (only owner/admin)
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const role = req.user.role;

        // Only owners/admins can delete
        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Only owners can delete inventory items' });
        }

        const result = await pool.query(
            'DELETE FROM inventory_items WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Inventory item not found' });
        }

        // Note: Cloudinary images persist even after deletion
        // To delete from Cloudinary, you'd need to extract the public_id and call cloudinary.uploader.destroy()

        res.json({ message: 'Inventory item deleted successfully' });
    } catch (err) {
        console.error('Error deleting inventory item:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
