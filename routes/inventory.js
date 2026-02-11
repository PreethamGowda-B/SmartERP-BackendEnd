const express = require('express');
const router = express.Router();
const multer = require('multer');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { storage, hasCloudinaryConfig } = require('../config/cloudinary');
const { trackCreation, trackAllChanges, trackDeletion, trackRestoration, getItemHistory } = require('../utils/inventoryHistory');

// Configure multer with Cloudinary storage or memory storage as fallback
const upload = multer({
    storage: storage || multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Predefined categories and units
const VALID_CATEGORIES = ['Raw Materials', 'Finished Goods', 'Tools', 'Supplies', 'Uncategorized'];
const VALID_UNITS = ['bags', 'kg', 'pieces', 'liters', 'boxes', 'meters', 'units'];

// ─── POST /api/inventory ─────────────────────────────────────────────────────
// Create inventory item (both owner and employee can add)
router.post('/', authenticateToken, upload.single('image'), async (req, res) => {
    try {
        const {
            name, description, quantity, category, unit, min_quantity,
            supplier_name, supplier_contact, supplier_email
        } = req.body;
        const userId = req.user.userId;

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Item name is required' });
        }

        // Validate category and unit
        const itemCategory = VALID_CATEGORIES.includes(category) ? category : 'Uncategorized';
        const itemUnit = VALID_UNITS.includes(unit) ? unit : 'pieces';

        // Get image URL from Cloudinary if file was uploaded
        let imageUrl = null;
        if (req.file) {
            if (hasCloudinaryConfig && req.file.path) {
                imageUrl = req.file.path; // Cloudinary URL
            } else if (req.file && !hasCloudinaryConfig) {
                console.warn('⚠️  Image uploaded but Cloudinary not configured. Skipping image.');
                imageUrl = null;
            }
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
       (name, description, quantity, image_url, created_by, employee_name, 
        category, unit, min_quantity, supplier_name, supplier_contact, supplier_email, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()) 
       RETURNING *`,
            [
                name.trim(),
                description?.trim() || null,
                parseInt(quantity) || 0,
                imageUrl,
                userId,
                employeeName,
                itemCategory,
                itemUnit,
                parseInt(min_quantity) || 0,
                supplier_name?.trim() || null,
                supplier_contact?.trim() || null,
                supplier_email?.trim() || null
            ]
        );

        // Track creation in history
        const newItem = result.rows[0];
        await trackCreation(newItem.id, newItem, userId, employeeName);

        // Send notification to all employees about new inventory
        try {
            const { createNotification } = require('../utils/notificationHelpers');
            const companyId = req.user.companyId;

            // Get all employees
            const employeesResult = await pool.query(
                `SELECT id FROM users WHERE role = 'employee'
                 ${companyId && companyId !== '00000000-0000-0000-0000-000000000000' ? 'AND (company_id = $1 OR company_id IS NULL)' : ''}`,
                companyId && companyId !== '00000000-0000-0000-0000-000000000000' ? [companyId] : []
            );

            // Send notification to each employee
            for (const employee of employeesResult.rows) {
                await createNotification({
                    user_id: employee.id,
                    company_id: companyId,
                    type: 'inventory_added',
                    title: 'New Inventory Added',
                    message: `${name} (${quantity} ${itemUnit}) has been added to inventory`,
                    priority: 'low',
                    data: { inventory_id: newItem.id, item_name: name, quantity }
                });
            }
            console.log(`✅ Notified ${employeesResult.rows.length} employees about new inventory`);
        } catch (notifErr) {
            console.error('❌ Failed to send inventory notification:', notifErr);
        }

        res.status(201).json(newItem);
    } catch (err) {
        console.error('Error creating inventory item:', err);
        res.status(500).json({ message: 'Server error creating inventory item' });
    }
});

// ─── GET /api/inventory ──────────────────────────────────────────────────────
// Get all inventory items (excluding deleted by default)
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { include_deleted, category, supplier } = req.query;

        let query = `SELECT 
        id, name, description, quantity, image_url, employee_name, office_name,
        created_by, created_at, updated_at, updated_by,
        category, unit, min_quantity,
        supplier_name, supplier_contact, supplier_email,
        is_deleted, deleted_at
       FROM inventory_items 
       WHERE 1=1`;

        const params = [];
        let paramIndex = 1;

        // Filter deleted items unless explicitly requested
        if (include_deleted !== 'true') {
            query += ` AND (is_deleted = FALSE OR is_deleted IS NULL)`;
        }

        // Filter by category
        if (category) {
            query += ` AND category = $${paramIndex}`;
            params.push(category);
            paramIndex++;
        }

        // Filter by supplier
        if (supplier) {
            query += ` AND supplier_name ILIKE $${paramIndex}`;
            params.push(`%${supplier}%`);
            paramIndex++;
        }

        query += ` ORDER BY created_at DESC`;

        const result = await pool.query(query, params);

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

// ─── PUT /api/inventory/:id ──────────────────────────────────────────────────
// Update inventory item
router.put('/:id', authenticateToken, upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const {
            name, description, quantity, category, unit, min_quantity,
            supplier_name, supplier_contact, supplier_email
        } = req.body;
        const userId = req.user.userId;

        // Get current item for history tracking
        const currentResult = await pool.query(
            'SELECT * FROM inventory_items WHERE id = $1',
            [id]
        );

        if (currentResult.rows.length === 0) {
            return res.status(404).json({ message: 'Inventory item not found' });
        }

        const oldItem = currentResult.rows[0];

        // Validate category and unit
        const itemCategory = VALID_CATEGORIES.includes(category) ? category : oldItem.category;
        const itemUnit = VALID_UNITS.includes(unit) ? unit : oldItem.unit;

        // Handle image upload
        let imageUrl = oldItem.image_url;
        if (req.file) {
            if (hasCloudinaryConfig && req.file.path) {
                imageUrl = req.file.path;
            }
        }

        // Get user name
        const userResult = await pool.query(
            'SELECT name, email FROM users WHERE id = $1',
            [userId]
        );
        const userName = userResult.rows[0]?.name || userResult.rows[0]?.email || 'Unknown';

        // Update item
        const result = await pool.query(
            `UPDATE inventory_items 
             SET name = $1, description = $2, quantity = $3, image_url = $4,
                 category = $5, unit = $6, min_quantity = $7,
                 supplier_name = $8, supplier_contact = $9, supplier_email = $10,
                 updated_by = $11, updated_at = NOW()
             WHERE id = $12
             RETURNING *`,
            [
                name?.trim() || oldItem.name,
                description?.trim() || oldItem.description,
                quantity !== undefined ? parseInt(quantity) : oldItem.quantity,
                imageUrl,
                itemCategory,
                itemUnit,
                min_quantity !== undefined ? parseInt(min_quantity) : oldItem.min_quantity,
                supplier_name?.trim() || oldItem.supplier_name,
                supplier_contact?.trim() || oldItem.supplier_contact,
                supplier_email?.trim() || oldItem.supplier_email,
                userId,
                id
            ]
        );

        const newItem = result.rows[0];

        // Track changes in history
        await trackAllChanges(id, oldItem, newItem, userId, userName);

        res.json(newItem);
    } catch (err) {
        console.error('Error updating inventory item:', err);
        res.status(500).json({ message: 'Server error updating inventory item' });
    }
});

// ─── PATCH /api/inventory/:id/archive ────────────────────────────────────────
// Soft delete (archive) inventory item (owner only)
router.patch('/:id/archive', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const role = req.user.role;
        const userId = req.user.userId;

        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Only owners can archive inventory items' });
        }

        // Get user name
        const userResult = await pool.query(
            'SELECT name, email FROM users WHERE id = $1',
            [userId]
        );
        const userName = userResult.rows[0]?.name || userResult.rows[0]?.email || 'Unknown';

        const result = await pool.query(
            `UPDATE inventory_items 
             SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = $1
             WHERE id = $2 AND (is_deleted = FALSE OR is_deleted IS NULL)
             RETURNING *`,
            [userId, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Inventory item not found or already archived' });
        }

        // Track deletion in history
        await trackDeletion(id, userId, userName);

        res.json({ message: 'Inventory item archived successfully', item: result.rows[0] });
    } catch (err) {
        console.error('Error archiving inventory item:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ─── PATCH /api/inventory/:id/restore ────────────────────────────────────────
// Restore archived inventory item (owner only)
router.patch('/:id/restore', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const role = req.user.role;
        const userId = req.user.userId;

        if (role !== 'owner' && role !== 'admin') {
            return res.status(403).json({ message: 'Only owners can restore inventory items' });
        }

        // Get user name
        const userResult = await pool.query(
            'SELECT name, email FROM users WHERE id = $1',
            [userId]
        );
        const userName = userResult.rows[0]?.name || userResult.rows[0]?.email || 'Unknown';

        const result = await pool.query(
            `UPDATE inventory_items 
             SET is_deleted = FALSE, deleted_at = NULL, deleted_by = NULL
             WHERE id = $1 AND is_deleted = TRUE
             RETURNING *`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Inventory item not found or not archived' });
        }

        // Track restoration in history
        await trackRestoration(id, userId, userName);

        res.json({ message: 'Inventory item restored successfully', item: result.rows[0] });
    } catch (err) {
        console.error('Error restoring inventory item:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ─── GET /api/inventory/:id/history ──────────────────────────────────────────
// Get history for a specific inventory item
router.get('/:id/history', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const history = await getItemHistory(id);

        res.json(history);
    } catch (err) {
        console.error('Error fetching inventory history:', err);
        res.status(500).json({ message: 'Server error fetching history' });
    }
});

// ─── GET /api/inventory/low-stock ────────────────────────────────────────────
// Get low-stock items (quantity < min_quantity)
router.get('/low-stock', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM inventory_items 
             WHERE (is_deleted = FALSE OR is_deleted IS NULL)
             AND quantity < min_quantity
             AND min_quantity > 0
             ORDER BY (quantity::float / NULLIF(min_quantity, 0)) ASC`
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching low-stock items:', err);
        res.status(500).json({ message: 'Server error fetching low-stock items' });
    }
});

module.exports = router;
