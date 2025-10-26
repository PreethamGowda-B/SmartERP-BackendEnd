const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// Create inventory item
router.post('/items', authenticateToken, async (req, res) => {
  const { sku, name, description, quantity, unit, location, reorder_threshold } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO inventory_items (sku, name, description, quantity, unit, location, reorder_threshold) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [sku, name, description, quantity || 0, unit || null, location || null, reorder_threshold || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// List inventory
router.get('/items', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory_items ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Create material request
// Create material request - only employees can create requests
router.post('/requests', authenticateToken, async (req, res) => {
  const { requestNumber, items } = req.body; // items: [{ inventory_item_id, name, quantity, unit }]
  try {
    if (req.user.role !== 'employee' && req.user.role !== 'user') {
      return res.status(403).json({ message: 'Only employees can create material requests' });
    }
    const result = await pool.query('INSERT INTO material_requests (request_number, requested_by) VALUES ($1,$2) RETURNING *', [requestNumber || null, req.user.userId]);
    const requestId = result.rows[0].id;
    for (const it of items || []) {
      await pool.query('INSERT INTO material_request_items (request_id, inventory_item_id, name, quantity, unit) VALUES ($1,$2,$3,$4,$5)', [requestId, it.inventory_item_id || null, it.name || null, it.quantity, it.unit || null]);
    }
    // Notify owners/admins about the new request
    try {
      const owners = await pool.query("SELECT id FROM users WHERE role = 'admin' OR role = 'owner'")
      for (const o of owners.rows) {
        await pool.query('INSERT INTO notifications (user_id, title, message) VALUES ($1,$2,$3)', [o.id, 'New Material Request', `User ${req.user.userId} created a new material request (#${requestId}).`])
      }
    } catch (nerr) {
      console.warn('Failed to create owner notifications for new material request', nerr)
    }
    res.json({ id: requestId });
  } catch (err) {
    console.error('Error creating material request', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// List requests
// List requests
// - employees see only their requests
// - owners/admins see all requests
router.get('/requests', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'employee' || req.user.role === 'user') {
      const result = await pool.query('SELECT * FROM material_requests WHERE requested_by = $1 ORDER BY created_at DESC', [req.user.userId]);
      return res.json(result.rows);
    }

    const result = await pool.query('SELECT * FROM material_requests ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing material requests', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Approve/reject a request - only owners/admins can perform
router.put('/requests/:id', authenticateToken, async (req, res) => {
  const { id } = req.params
  const { action } = req.body // 'approve' or 'reject'
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Only owners or admins can approve or reject requests' });
    }

    if (action === 'approve') {
      await pool.query('UPDATE material_requests SET status = $1, approved_by = $2, updated_at = NOW() WHERE id = $3', ['approved', req.user.userId, id])
      // notify requester
      try {
        const r = await pool.query('SELECT requested_by FROM material_requests WHERE id = $1', [id])
        const requesterId = r.rows[0]?.requested_by
        if (requesterId) {
          await pool.query('INSERT INTO notifications (user_id, title, message) VALUES ($1,$2,$3)', [requesterId, 'Material Request Approved', `Your material request #${id} has been approved.`])
        }
      } catch (nerr) {
        console.warn('Failed to notify requester about approval', nerr)
      }
      return res.json({ ok: true })
    }

    if (action === 'reject') {
      await pool.query('UPDATE material_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['rejected', id])
      try {
        const r = await pool.query('SELECT requested_by FROM material_requests WHERE id = $1', [id])
        const requesterId = r.rows[0]?.requested_by
        if (requesterId) {
          await pool.query('INSERT INTO notifications (user_id, title, message) VALUES ($1,$2,$3)', [requesterId, 'Material Request Rejected', `Your material request #${id} has been rejected.`])
        }
      } catch (nerr) {
        console.warn('Failed to notify requester about rejection', nerr)
      }
      return res.json({ ok: true })
    }

    res.status(400).json({ message: 'Invalid action' })
  } catch (err) {
    console.error('Error updating material request', err)
    res.status(500).json({ message: 'Server error' })
  }
});

module.exports = router;