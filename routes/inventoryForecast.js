const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authMiddleware');
const checkPermission = require('../middleware/rbac');
const { pool } = require('../db');
const InventoryForecastService = require('../services/inventoryForecastService');

router.use(authenticateToken);

/**
 * GET /api/v1/inventory/forecasts
 * Lists all inventory forecasts and ROP breach statuses.
 */
router.get('/forecasts', checkPermission('inventory:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const result = await pool.query(
      `SELECT f.*, i.name as item_name, i.quantity as current_quantity, i.unit, i.category
       FROM inventory_forecasts f
       JOIN inventory_items i ON f.item_id = i.id
       WHERE f.company_id = $1
       ORDER BY f.is_rop_breached DESC, i.name ASC`,
      [companyId]
    );

    return res.json({ success: true, count: result.rows.length, forecasts: result.rows });
  } catch (err) {
    console.error('Error fetching inventory forecasts:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve inventory forecasts.' });
  }
});

/**
 * POST /api/v1/inventory/forecasts/recalculate
 * Triggers ROP and EOQ demand recalculation for company inventory.
 */
router.post('/forecasts/recalculate', checkPermission('inventory:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const updated = await InventoryForecastService.recalculateCompanyForecasts(companyId);
    return res.json({
      success: true,
      message: `Recalculated demand forecasts and ROP for ${updated.length} inventory items.`,
      count: updated.length,
    });
  } catch (err) {
    console.error('Error recalculating forecasts:', err.message);
    return res.status(500).json({ error: 'Failed to recalculate demand forecasts.' });
  }
});

/**
 * GET /api/v1/inventory/suppliers
 * Lists company suppliers directory.
 */
router.get('/suppliers', checkPermission('inventory:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const result = await pool.query(
      `SELECT * FROM inventory_suppliers WHERE company_id = $1 ORDER BY supplier_name ASC`,
      [companyId]
    );
    return res.json({ success: true, count: result.rows.length, suppliers: result.rows });
  } catch (err) {
    console.error('Error fetching suppliers:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve suppliers directory.' });
  }
});

/**
 * POST /api/v1/inventory/suppliers
 * Creates a new supplier record.
 */
router.post('/suppliers', checkPermission('inventory:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { supplierName, contactPerson, email, phone, address, gstin, defaultLeadTimeDays } = req.body;

    if (!supplierName || !email) {
      return res.status(400).json({ error: 'Supplier Name and Email are required.' });
    }

    const result = await pool.query(
      `INSERT INTO inventory_suppliers
       (company_id, supplier_name, contact_person, email, phone, address, gstin, default_lead_time_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [companyId, supplierName, contactPerson || null, email, phone || null, address || null, gstin || null, defaultLeadTimeDays || 7]
    );

    return res.status(201).json({ success: true, supplier: result.rows[0] });
  } catch (err) {
    console.error('Error creating supplier:', err.message);
    return res.status(500).json({ error: 'Failed to create supplier.' });
  }
});

/**
 * GET /api/v1/inventory/purchase-orders
 * Lists purchase orders for the company.
 */
router.get('/purchase-orders', checkPermission('inventory:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status } = req.query;

    let query = `
      SELECT po.*, s.supplier_name, s.email as supplier_email, u.name as creator_name
      FROM inventory_purchase_orders po
      JOIN inventory_suppliers s ON po.supplier_id = s.id
      LEFT JOIN users u ON po.created_by = u.id
      WHERE po.company_id = $1
    `;
    const params = [companyId];

    if (status) {
      params.push(status);
      query += ` AND po.status = $2`;
    }

    query += ` ORDER BY po.created_at DESC`;

    const result = await pool.query(query, params);
    return res.json({ success: true, count: result.rows.length, purchaseOrders: result.rows });
  } catch (err) {
    console.error('Error fetching purchase orders:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve purchase orders.' });
  }
});

/**
 * POST /api/v1/inventory/purchase-orders
 * Creates an Agentic Draft Purchase Order.
 */
router.post('/purchase-orders', checkPermission('inventory:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const userId = req.user.userId;
    const { supplierId, itemsToReorder } = req.body;

    if (!supplierId || !itemsToReorder || itemsToReorder.length === 0) {
      return res.status(400).json({ error: 'Supplier ID and at least one line item are required.' });
    }

    const poResult = await InventoryForecastService.generateAgenticDraftPO({
      companyId,
      userId,
      supplierId,
      itemsToReorder,
    });

    return res.status(201).json({ success: true, purchaseOrder: poResult });
  } catch (err) {
    console.error('Error creating purchase order:', err.message);
    return res.status(500).json({ error: 'Failed to generate purchase order.' });
  }
});

/**
 * PATCH /api/v1/inventory/purchase-orders/:id/approve
 * Approves a Purchase Order and transitions status to sent_to_supplier.
 */
router.patch('/purchase-orders/:id/approve', checkPermission('inventory:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE inventory_purchase_orders
       SET status = 'sent_to_supplier', updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Purchase Order not found.' });
    }

    return res.json({ success: true, purchaseOrder: result.rows[0] });
  } catch (err) {
    console.error('Error approving purchase order:', err.message);
    return res.status(500).json({ error: 'Failed to approve purchase order.' });
  }
});

module.exports = router;
