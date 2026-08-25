const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/warranty-claims ──────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && req.user.role !== 'super_admin') {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }

    const query = req.user.role === 'super_admin'
      ? `SELECT w.*, COALESCE(w.spare_part_name, w.part_name, 'CNC Spare Part') as spare_part_name,
                COALESCE(w.supplier_name, w.vendor_name, 'Approved Vendor') as supplier_name,
                COALESCE(m.machine_name, 'CNC Machine') as machine_name, m.serial_number as machine_sn
         FROM warranty_claims w
         LEFT JOIN customer_machines m ON w.machine_id::text = m.id::text
         ORDER BY w.created_at DESC`
      : `SELECT w.*, COALESCE(w.spare_part_name, w.part_name, 'CNC Spare Part') as spare_part_name,
                COALESCE(w.supplier_name, w.vendor_name, 'Approved Vendor') as supplier_name,
                COALESCE(m.machine_name, 'CNC Machine') as machine_name, m.serial_number as machine_sn
         FROM warranty_claims w
         LEFT JOIN customer_machines m ON w.machine_id::text = m.id::text
         WHERE w.company_id::text = $1::text
         ORDER BY w.created_at DESC`;

    const params = req.user.role === 'super_admin' ? [] : [String(companyId)];
    const result = await pool.query(query, params).catch(() => ({ rows: [] }));

    res.json({ success: true, claims: result.rows });
  } catch (err) {
    console.error('❌ Error fetching warranty claims:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ─── POST /api/warranty-claims (Create Supplier Warranty Claim) ────────────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }
    const { machine_id, job_id, spare_part_name, serial_number, supplier_name, failure_reason } = req.body;

    if (!machine_id || !spare_part_name || !supplier_name) {
      return res.status(400).json({ message: 'machine_id, spare_part_name, and supplier_name are required' });
    }

    const claimNum = `WC-${Date.now().toString().slice(-6)}`;

    const result = await pool.query(
      `INSERT INTO warranty_claims
         (company_id, claim_number, machine_id, job_id, spare_part_name, serial_number, supplier_name, failure_reason, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', NOW(), NOW())
       RETURNING *`,
      [String(companyId), claimNum, machine_id, job_id || null, spare_part_name, serial_number || null, supplier_name, failure_reason || '']
    );

    const claim = result.rows[0];

    // Log event on Machine Timeline
    await pool.query(
      `INSERT INTO machine_timeline_events (company_id, machine_id, event_type, title, description, created_at)
       VALUES ($1, $2, 'warranty_claim', 'Supplier Warranty Claim Raised', $3, NOW())`,
      [String(companyId), machine_id, `Warranty Claim ${claimNum} raised for ${spare_part_name} to supplier ${supplier_name}`]
    ).catch(() => {});

    res.status(201).json({ success: true, claim });
  } catch (err) {
    console.error('❌ Error creating warranty claim:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── POST /api/warranty-claims/:id/resolve (Supplier Approval & Credit Note) ─
router.post('/:id/resolve', authenticateToken, async (req, res) => {
  try {
    const userRole = req.user.role;
    const isAuthorized = ['owner', 'admin', 'super_admin'].includes(userRole);
    if (!isAuthorized) {
      return res.status(403).json({ message: 'Access denied: Only owners or admins can resolve warranty claims.' });
    }

    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && userRole !== 'super_admin') {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }

    const { id } = req.params;
    const { status = 'approved', credit_amount = 0 } = req.body;

    const query = userRole === 'super_admin'
      ? `UPDATE warranty_claims
         SET status = $1, supplier_credit_amount = $2, updated_at = NOW()
         WHERE id::text = $3::text
         RETURNING *`
      : `UPDATE warranty_claims
         SET status = $1, supplier_credit_amount = $2, updated_at = NOW()
         WHERE id::text = $3::text AND company_id::text = $4::text
         RETURNING *`;

    const params = userRole === 'super_admin'
      ? [status, credit_amount, id]
      : [status, credit_amount, id, String(companyId)];

    const result = await pool.query(query, params);

    if (result.rows.length === 0) return res.status(404).json({ message: 'Warranty claim not found or access denied.' });

    const claim = result.rows[0];

    // Log timeline event
    if (claim.machine_id) {
      await pool.query(
        `INSERT INTO machine_timeline_events (company_id, machine_id, event_type, title, description, created_at)
         VALUES ($1, $2, 'warranty_claim', 'Supplier Warranty Claim Approved', $3, NOW())`,
        [claim.company_id, claim.machine_id, `Claim ${claim.claim_number} approved by ${claim.supplier_name}. Credit Note Issued: ₹${credit_amount}`]
      ).catch(() => {});
    }

    res.json({ success: true, claim });
  } catch (err) {
    console.error('❌ Error resolving warranty claim:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
