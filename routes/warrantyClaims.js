const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

const WARRANTY_READ_ROLES = new Set(['owner', 'admin', 'super_admin']);
const WARRANTY_SUBMIT_ROLES = new Set(['owner', 'admin', 'employee']);
const WARRANTY_REVIEW_ROLES = new Set(['owner', 'admin', 'super_admin']);
const WARRANTY_REVIEW_STATUSES = new Set(['under_review', 'approved', 'rejected']);
const MAX_CREDIT_AMOUNT = 99999999.99;

function roleOf(user) {
  return String(user?.role || '').toLowerCase();
}

function canTransitionWarrantyClaim(currentStatus, nextStatus) {
  const current = String(currentStatus || '').toLowerCase();
  const next = String(nextStatus || '').toLowerCase();
  if (current === 'submitted') return WARRANTY_REVIEW_STATUSES.has(next);
  if (current === 'under_review') return next === 'approved' || next === 'rejected';
  return false;
}

function createWarrantyClaimsReadHandler(query = (...args) => pool.query(...args)) {
  return async (req, res) => {
    const role = roleOf(req.user);
    if (!WARRANTY_READ_ROLES.has(role)) {
      return res.status(403).json({ success: false, message: 'Only owners and administrators can view supplier warranty claims.' });
    }
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && role !== 'super_admin') {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }

    const sql = role === 'super_admin'
      ? `SELECT w.*, COALESCE(w.spare_part_name, w.part_name) as spare_part_name,
                COALESCE(w.supplier_name, w.vendor_name) as supplier_name,
                m.machine_name, m.serial_number as machine_sn
         FROM warranty_claims w
         LEFT JOIN customer_machines m ON w.machine_id::text = m.id::text AND w.company_id::text = m.company_id::text
         ORDER BY w.created_at DESC`
      : `SELECT w.*, COALESCE(w.spare_part_name, w.part_name) as spare_part_name,
                COALESCE(w.supplier_name, w.vendor_name) as supplier_name,
                m.machine_name, m.serial_number as machine_sn
         FROM warranty_claims w
         LEFT JOIN customer_machines m ON w.machine_id::text = m.id::text AND w.company_id::text = m.company_id::text
         WHERE w.company_id::text = $1::text
         ORDER BY w.created_at DESC`;

    try {
      const result = await query(sql, role === 'super_admin' ? [] : [String(companyId)]);
      return res.json({ success: true, claims: result.rows });
    } catch (err) {
      console.error('CNC warranty claims read failed:', err?.code || 'DATABASE_ERROR');
      return res.status(500).json({ success: false, message: 'Failed to load warranty claims.' });
    }
  };
}

function createWarrantyClaimHandler(db = pool) {
  return async (req, res) => {
    const role = roleOf(req.user);
    if (!WARRANTY_SUBMIT_ROLES.has(role)) {
      return res.status(403).json({ success: false, message: 'Your role cannot submit supplier warranty claims.' });
    }
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing company context.' });
    }

    const body = req.body || {};
    const machineId = body.machine_id == null ? '' : String(body.machine_id).trim();
    const jobId = body.job_id == null || body.job_id === '' ? null : String(body.job_id).trim();
    const sparePartName = typeof body.spare_part_name === 'string' ? body.spare_part_name.trim() : '';
    const supplierName = typeof body.supplier_name === 'string' ? body.supplier_name.trim() : '';
    const serialNumber = typeof body.serial_number === 'string' ? body.serial_number.trim() : '';
    const failureReason = typeof body.failure_reason === 'string' ? body.failure_reason.trim() : '';

    if (!machineId || !sparePartName || !supplierName) {
      return res.status(400).json({ success: false, message: 'machine_id, spare_part_name, and supplier_name are required.' });
    }
    if (sparePartName.length > 255 || supplierName.length > 255 || serialNumber.length > 100) {
      return res.status(400).json({ success: false, message: 'Warranty claim fields exceed the supported length.' });
    }

    let client;
    let transactionOpen = false;
    try {
      client = await db.connect();
      await client.query('BEGIN');
      transactionOpen = true;

      const machine = await client.query(
        'SELECT id FROM customer_machines WHERE id::text = $1::text AND company_id::text = $2::text FOR KEY SHARE',
        [machineId, String(companyId)]
      );
      if (!machine.rows.length) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(404).json({ success: false, message: 'The selected machine was not found for this company.' });
      }
      if (jobId) {
        const job = await client.query(
          'SELECT id FROM jobs WHERE id::text = $1::text AND company_id::text = $2::text FOR KEY SHARE',
          [jobId, String(companyId)]
        );
        if (!job.rows.length) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return res.status(404).json({ success: false, message: 'The selected job was not found for this company.' });
        }
      }

      const claimNum = `WC-${Date.now().toString().slice(-6)}`;
      const result = await client.query(
        `INSERT INTO warranty_claims
           (company_id, claim_number, machine_id, job_id, spare_part_name, serial_number, supplier_name, failure_reason, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', NOW(), NOW())
         RETURNING *`,
        [String(companyId), claimNum, machineId, jobId, sparePartName, serialNumber || null, supplierName, failureReason]
      );
      const claim = result.rows[0];
      if (!claim) throw new Error('Warranty claim was not persisted.');

      await client.query(
        `INSERT INTO machine_timeline_events (company_id, machine_id, event_type, title, description, created_at)
         VALUES ($1, $2, 'warranty_claim', 'Supplier Warranty Claim Raised', $3, NOW())`,
        [String(companyId), machineId, `Warranty claim ${claimNum} raised for ${sparePartName} to supplier ${supplierName}.`]
      );

      await client.query('COMMIT');
      transactionOpen = false;
      return res.status(201).json({ success: true, claim });
    } catch (err) {
      if (transactionOpen && client) await client.query('ROLLBACK').catch(() => {});
      console.error('CNC warranty claim creation failed:', err?.code || 'DATABASE_ERROR');
      return res.status(500).json({ success: false, message: 'Failed to create warranty claim.' });
    } finally {
      client?.release();
    }
  };
}

function createWarrantyClaimResolveHandler(db = pool) {
  return async (req, res) => {
    const role = roleOf(req.user);
    if (!WARRANTY_REVIEW_ROLES.has(role)) {
      return res.status(403).json({ success: false, message: 'Only owners or administrators can review warranty claims.' });
    }
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && role !== 'super_admin') {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing company context.' });
    }

    const requestedStatus = String(req.body?.status || 'approved').toLowerCase();
    const rawCreditAmount = req.body?.credit_amount == null ? 0 : Number(req.body.credit_amount);
    if (!WARRANTY_REVIEW_STATUSES.has(requestedStatus)) {
      return res.status(400).json({ success: false, message: 'status must be under_review, approved, or rejected.' });
    }
    if (!Number.isFinite(rawCreditAmount) || rawCreditAmount < 0 || rawCreditAmount > MAX_CREDIT_AMOUNT) {
      return res.status(400).json({ success: false, message: 'credit_amount must be a finite non-negative amount within the supported limit.' });
    }
    const creditAmount = Math.round((rawCreditAmount + Number.EPSILON) * 100) / 100;

    let client;
    let transactionOpen = false;
    try {
      client = await db.connect();
      await client.query('BEGIN');
      transactionOpen = true;

      const lookup = role === 'super_admin'
        ? await client.query('SELECT * FROM warranty_claims WHERE id::text = $1::text FOR UPDATE', [String(req.params.id)])
        : await client.query('SELECT * FROM warranty_claims WHERE id::text = $1::text AND company_id::text = $2::text FOR UPDATE', [String(req.params.id), String(companyId)]);
      if (!lookup.rows.length) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(404).json({ success: false, message: 'Warranty claim not found or access denied.' });
      }

      const existing = lookup.rows[0];
      if (!canTransitionWarrantyClaim(existing.status, requestedStatus)) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(409).json({ success: false, message: `A warranty claim in ${existing.status} status cannot be changed to ${requestedStatus}.` });
      }

      const companyScope = String(existing.company_id);
      const update = await client.query(
        `UPDATE warranty_claims
            SET status = $1, supplier_credit_amount = $2, updated_at = NOW()
          WHERE id::text = $3::text AND company_id::text = $4::text AND status = $5
          RETURNING *`,
        [requestedStatus, creditAmount, String(req.params.id), companyScope, String(existing.status)]
      );
      if (!update.rows.length) throw new Error('Warranty claim status changed before review completed.');

      const claim = update.rows[0];
      if (claim.machine_id) {
        const estimateNote = creditAmount > 0
          ? ` Supplier credit amount recorded: ₹${creditAmount.toFixed(2)}; no finance credit note was issued.`
          : ' No finance credit note was issued.';
        await client.query(
          `INSERT INTO machine_timeline_events (company_id, machine_id, event_type, title, description, created_at)
           VALUES ($1, $2, 'warranty_claim', $3, $4, NOW())`,
          [companyScope, String(claim.machine_id), `Supplier warranty claim ${requestedStatus}`, `Claim ${claim.claim_number || claim.id} moved from ${existing.status} to ${requestedStatus}.${estimateNote}`]
        );
      }

      await client.query('COMMIT');
      transactionOpen = false;
      return res.json({ success: true, claim });
    } catch (err) {
      if (transactionOpen && client) await client.query('ROLLBACK').catch(() => {});
      console.error('CNC warranty claim review failed:', err?.code || 'DATABASE_ERROR');
      return res.status(500).json({ success: false, message: 'Failed to review warranty claim.' });
    } finally {
      client?.release();
    }
  };
}

router.get('/', authenticateToken, createWarrantyClaimsReadHandler());
router.post('/', authenticateToken, createWarrantyClaimHandler());
router.post('/:id/resolve', authenticateToken, createWarrantyClaimResolveHandler());

module.exports = router;
module.exports.createWarrantyClaimsReadHandler = createWarrantyClaimsReadHandler;
module.exports.createWarrantyClaimHandler = createWarrantyClaimHandler;
module.exports.createWarrantyClaimResolveHandler = createWarrantyClaimResolveHandler;
module.exports.canTransitionWarrantyClaim = canTransitionWarrantyClaim;
