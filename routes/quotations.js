const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/quotations ───────────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;
    const { customer_id, status } = req.query;

    let query = `
      SELECT q.*, c.name as customer_name, m.machine_name, m.serial_number, m.controller_type
      FROM service_quotations q
      LEFT JOIN customers c ON q.customer_id::text = c.id::text
      LEFT JOIN customer_machines m ON q.machine_id::text = m.id::text
      WHERE q.company_id::text = $1::text
    `;
    const params = [companyId];

    if (customer_id) {
      params.push(customer_id);
      query += ` AND q.customer_id::text = $${params.length}::text`;
    }

    if (status) {
      params.push(status);
      query += ` AND q.status = $${params.length}`;
    }

    query += ` ORDER BY q.created_at DESC`;

    const result = await pool.query(query, params);
    res.json({ success: true, quotations: result.rows });
  } catch (err) {
    console.error('❌ Error fetching quotations:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── POST /api/quotations (Create Service Quotation/Estimate) ──────────────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;
    const { customer_id, machine_id, title, labor_amount = 0, spares_amount = 0, travel_amount = 0 } = req.body;

    if (!customer_id || !title) {
      return res.status(400).json({ message: 'customer_id and title are required' });
    }

    const qNumber = `QT-${Date.now().toString().slice(-6)}`;
    const totalAmount = Number(labor_amount || 0) + Number(spares_amount || 0) + Number(travel_amount || 0);

    const result = await pool.query(
      `INSERT INTO service_quotations
         (company_id, quotation_number, customer_id, machine_id, title, labor_amount, spares_amount, travel_amount, total_amount, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'sent', NOW(), NOW())
       RETURNING *, 'V1' as version`,
      [companyId, qNumber, customer_id, machine_id || null, title, labor_amount, spares_amount, travel_amount, totalAmount]
    );

    res.status(201).json({ success: true, quotation: result.rows[0] });
  } catch (err) {
    console.error('❌ Error creating quotation:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── POST /api/quotations/:id/revise (Create Revised Version V2, V3) ───────
router.post('/:id/revise', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;
    const { id } = req.params;
    const { title, labor_amount, spares_amount, travel_amount, revision_notes } = req.body;

    const existingRes = await pool.query(`SELECT * FROM service_quotations WHERE id::text = $1::text AND company_id::text = $2::text`, [id, companyId]);
    if (existingRes.rows.length === 0) return res.status(404).json({ message: 'Quotation not found' });

    const ex = existingRes.rows[0];
    const totalAmount = Number(labor_amount ?? ex.labor_amount) + Number(spares_amount ?? ex.spares_amount) + Number(travel_amount ?? ex.travel_amount);

    const result = await pool.query(
      `UPDATE service_quotations
       SET title = COALESCE($1, title),
           labor_amount = COALESCE($2, labor_amount),
           spares_amount = COALESCE($3, spares_amount),
           travel_amount = COALESCE($4, travel_amount),
           total_amount = $5,
           status = 'sent',
           updated_at = NOW()
       WHERE id = $6
       RETURNING *, 'V2 (Revised)' as version`,
      [title || null, labor_amount, spares_amount, travel_amount, totalAmount, id]
    );

    res.json({ success: true, quotation: result.rows[0], message: 'Quotation revised to V2!' });
  } catch (err) {
    console.error('❌ Error revising quotation:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── POST /api/quotations/:id/approve (Approve & Convert to Job) ────────────
router.post('/:id/approve', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;
    const { id } = req.params;

    const qRes = await pool.query(
      `SELECT * FROM service_quotations WHERE id::text = $1::text AND company_id::text = $2::text`,
      [id, companyId]
    );

    if (qRes.rows.length === 0) {
      return res.status(404).json({ message: 'Quotation not found' });
    }

    const q = qRes.rows[0];

    // Create standard SmartERP Job from approved quotation
    const jobRes = await pool.query(
      `INSERT INTO jobs (title, description, customer_id, company_id, machine_id, service_type, priority, status, employee_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'breakdown', 'high', 'open', 'pending', NOW(), NOW())
       RETURNING *`,
      [
        `[Approved Quotation ${q.quotation_number}] ${q.title}`,
        `Approved Service Estimate: Total ₹${q.total_amount}. Labor: ₹${q.labor_amount}, Spares: ₹${q.spares_amount}, Travel: ₹${q.travel_amount}`,
        q.customer_id,
        companyId,
        q.machine_id,
      ]
    );

    const job = jobRes.rows[0];

    // Update quotation state
    await pool.query(
      `UPDATE service_quotations SET status = 'converted_to_job', job_id = $1, updated_at = NOW() WHERE id = $2`,
      [job.id, id]
    );

    // Log timeline event
    if (q.machine_id) {
      await pool.query(
        `INSERT INTO machine_timeline_events (company_id, machine_id, job_id, event_type, title, description, created_at)
         VALUES ($1, $2, $3, 'work_started', 'Quotation Approved & Job Created', $4, NOW())`,
        [companyId, q.machine_id, job.id, `Quotation ${q.quotation_number} approved by customer for ₹${q.total_amount}`]
      ).catch(() => {});
    }

    res.json({ success: true, message: 'Quotation approved and converted to Job!', job });
  } catch (err) {
    console.error('❌ Error approving quotation:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
