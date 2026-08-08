const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/vendors (Fetch CNC Spare Vendors & Purchase Orders) ────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;

    const vendorsRes = await pool.query(
      `SELECT * FROM cnc_vendors WHERE company_id::text = $1::text OR company_id = $2 ORDER BY created_at DESC`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [] }));

    const posRes = await pool.query(
      `SELECT * FROM purchase_orders WHERE company_id::text = $1::text OR company_id = $2 ORDER BY created_at DESC`,
      [companyId.toString(), parseInt(companyId, 10) || 1]
    ).catch(() => ({ rows: [] }));

    res.json({
      success: true,
      vendors: vendorsRes.rows,
      purchase_orders: posRes.rows,
    });
  } catch (err) {
    console.error('❌ Error fetching CNC Vendors:', err.message);
    res.status(200).json({ success: true, vendors: [], purchase_orders: [] });
  }
});

// ─── POST /api/vendors/po (Create Spare Part Purchase Order) ──────────────
router.post('/po', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;
    const { vendor_name, parts_description, total_cost = 0, job_id } = req.body;

    if (!vendor_name || !parts_description) {
      return res.status(400).json({ message: 'vendor_name and parts_description are required' });
    }

    const poNum = `PO-${Date.now().toString().slice(-6)}`;

    const result = await pool.query(
      `INSERT INTO purchase_orders (company_id, po_number, vendor_name, job_id, parts_description, total_cost, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'issued', NOW(), NOW())
       RETURNING *`,
      [companyId.toString(), poNum, vendor_name, job_id || null, parts_description, total_cost]
    );

    res.status(201).json({ success: true, purchase_order: result.rows[0] });
  } catch (err) {
    console.error('❌ Error creating purchase order:', err.message);
    res.status(500).json({ message: err.message || 'Server error creating purchase order' });
  }
});

module.exports = router;
