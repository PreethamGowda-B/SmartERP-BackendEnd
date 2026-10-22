const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

const MAX_PURCHASE_ORDER_COST = 9999999999.99;
const CNC_PURCHASING_ROLES = new Set(['owner', 'admin', 'super_admin']);

function hasCncPurchasingAccess(user) {
  return CNC_PURCHASING_ROLES.has(String(user?.role || '').toLowerCase());
}

function validatePurchaseOrderPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, message: 'A purchase order payload is required.' };
  }

  const vendorName = typeof body.vendor_name === 'string' ? body.vendor_name.trim() : '';
  const partsDescription = typeof body.parts_description === 'string' ? body.parts_description.trim() : '';
  if (!vendorName || vendorName.length > 255) {
    return { valid: false, message: 'vendor_name is required and must be 255 characters or fewer.' };
  }
  if (!partsDescription) {
    return { valid: false, message: 'parts_description is required.' };
  }

  const rawCost = body.total_cost;
  const totalCost = typeof rawCost === 'number' || (typeof rawCost === 'string' && rawCost.trim() !== '')
    ? Number(rawCost)
    : Number.NaN;
  if (!Number.isFinite(totalCost) || totalCost < 0 || totalCost > MAX_PURCHASE_ORDER_COST) {
    return { valid: false, message: 'total_cost must be a finite amount from 0 to 9,999,999,999.99.' };
  }

  let jobId = null;
  if (body.job_id !== undefined && body.job_id !== null && body.job_id !== '') {
    jobId = Number(body.job_id);
    if (!Number.isSafeInteger(jobId) || jobId <= 0 || jobId > 2147483647) {
      return { valid: false, message: 'job_id must be a positive integer.' };
    }
  }

  return { valid: true, value: { vendorName, partsDescription, totalCost, jobId } };
}

function createPurchaseOrderHandler(query = (...args) => pool.query(...args)) {
  return async (req, res) => {
    const companyId = req.user?.companyId || req.user?.company_id;
    if (!companyId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing company context.' });
    }
    if (req.user?.role && !hasCncPurchasingAccess(req.user)) {
      return res.status(403).json({ success: false, message: 'Only company owners or administrators can manage CNC purchase orders.' });
    }

    const validation = validatePurchaseOrderPayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    const { vendorName, partsDescription, totalCost, jobId } = validation.value;
    const poNum = `PO-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    try {
      if (jobId !== null) {
        const job = await query(
          `SELECT id FROM jobs WHERE id::text = $1::text AND company_id::text = $2::text LIMIT 1`,
          [String(jobId), String(companyId)]
        );
        if (!job.rows?.length) {
          return res.status(404).json({ success: false, message: 'The selected job was not found for this company.' });
        }
      }

      const result = await query(
        `INSERT INTO purchase_orders (company_id, po_number, vendor_name, job_id, parts_description, total_cost, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'issued', NOW(), NOW())
         RETURNING *`,
        [String(companyId), poNum, vendorName, jobId, partsDescription, totalCost]
      );
      if (!result.rows?.[0]) {
        return res.status(500).json({ success: false, message: 'Failed to create purchase order.' });
      }
      return res.status(201).json({ success: true, purchase_order: result.rows[0] });
    } catch (err) {
      console.error('CNC purchase order creation failed:', err?.code || 'DATABASE_ERROR');
      return res.status(500).json({ success: false, message: 'Failed to create purchase order.' });
    }
  };
}

function createVendorReadHandler(query = (...args) => pool.query(...args)) {
  return async (req, res) => {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && req.user.role !== 'super_admin') {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }
    if (req.user?.role && !hasCncPurchasingAccess(req.user)) {
      return res.status(403).json({ success: false, message: 'Only company owners or administrators can view CNC suppliers and purchase orders.' });
    }

    const queryVendors = req.user.role === 'super_admin'
      ? 'SELECT * FROM cnc_vendors ORDER BY created_at DESC'
      : 'SELECT * FROM cnc_vendors WHERE company_id::text = $1::text ORDER BY created_at DESC';
    const queryPOs = req.user.role === 'super_admin'
      ? 'SELECT * FROM purchase_orders ORDER BY created_at DESC'
      : 'SELECT * FROM purchase_orders WHERE company_id::text = $1::text ORDER BY created_at DESC';
    const params = req.user.role === 'super_admin' ? [] : [String(companyId)];

    try {
      const [vendorsRes, posRes] = await Promise.all([
        query(queryVendors, params),
        query(queryPOs, params),
      ]);
      return res.json({ success: true, vendors: vendorsRes.rows, purchase_orders: posRes.rows });
    } catch (err) {
      console.error('CNC vendor data read failed:', err?.code || 'DATABASE_ERROR');
      return res.status(500).json({ success: false, message: 'Failed to load CNC vendor data.' });
    }
  };
}

// ─── GET /api/vendors (Fetch CNC Spare Vendors & Purchase Orders) ────────────
router.get('/', authenticateToken, createVendorReadHandler());

// ─── POST /api/vendors/po (Create Spare Part Purchase Order) ──────────────
router.post('/po', authenticateToken, createPurchaseOrderHandler());

module.exports = router;
module.exports.validatePurchaseOrderPayload = validatePurchaseOrderPayload;
module.exports.createPurchaseOrderHandler = createPurchaseOrderHandler;
module.exports.createVendorReadHandler = createVendorReadHandler;
