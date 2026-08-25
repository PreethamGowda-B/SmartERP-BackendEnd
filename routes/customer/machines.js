/**
 * routes/customer/machines.js
 *
 * Dedicated router for Customer Portal CNC machine registry & management.
 * Protected by authenticateCustomer middleware.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../../db');

// ─── GET /api/customer/machines (List machines) ──────────────────────────────
router.get('/', async (req, res) => {
  try {
    const customerId = req.customer?.id || req.customer?.userId;
    const companyId = req.customer?.companyId || req.customer?.company_id;

    if (!customerId || !companyId) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Missing customer or company context' });
    }

    const { search } = req.query;

    let query = `
      SELECT m.*, COALESCE(c.name, c.email, 'Customer') as customer_name
      FROM customer_machines m
      LEFT JOIN customers c ON m.customer_id::text = c.id::text
      WHERE m.company_id::text = $1::text AND m.customer_id::text = $2::text
    `;
    const params = [companyId, customerId];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (m.machine_name ILIKE $${params.length} OR m.serial_number ILIKE $${params.length} OR m.make ILIKE $${params.length} OR m.model ILIKE $${params.length} OR m.controller_type ILIKE $${params.length})`;
    }

    query += ` ORDER BY m.created_at DESC`;

    const result = await pool.query(query, params).catch(async (err) => {
      console.warn("⚠️ Customer machines query with joins failed, using simple query:", err.message);
      return pool.query(
        `SELECT * FROM customer_machines WHERE company_id::text = $1::text AND customer_id::text = $2::text ORDER BY created_at DESC`,
        [companyId, customerId]
      ).catch(() => ({ rows: [] }));
    });

    res.json({ success: true, machines: result.rows || [] });
  } catch (err) {
    console.error('❌ Error fetching customer machines:', err.message);
    res.json({ success: true, machines: [] });
  }
});

// ─── POST /api/customer/machines (Register new CNC machine) ──────────────────
router.post('/', async (req, res) => {
  try {
    const customerId = req.customer?.id || req.customer?.userId;
    const companyId = req.customer?.companyId || req.customer?.company_id;

    if (!customerId || !companyId) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Missing customer or company context' });
    }

    const {
      machine_name,
      make = 'Generic CNC',
      model = 'Standard',
      serial_number,
      controller_type = 'Fanuc 0i-MF',
      spindle_hours = 0,
    } = req.body;

    if (!machine_name || !serial_number) {
      return res.status(400).json({ success: false, error: 'Machine name and serial number are required' });
    }

    const insertQuery = `
      INSERT INTO customer_machines
      (company_id, customer_id, machine_name, make, model, serial_number, controller_type, spindle_hours, health_score, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 100, 'operational')
      RETURNING *
    `;

    const result = await pool.query(insertQuery, [
      companyId,
      customerId,
      machine_name.trim(),
      make.trim(),
      model.trim(),
      serial_number.trim(),
      controller_type.trim(),
      parseInt(spindle_hours) || 0,
    ]);

    res.status(201).json({ success: true, machine: result.rows[0] });
  } catch (err) {
    console.error('❌ Error registering customer machine:', err.message);
    res.status(500).json({ success: false, error: err.message || 'Failed to register machine' });
  }
});

// ─── GET /api/customer/machines/:id (Machine details) ──────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const customerId = req.customer?.id || req.customer?.userId;
    const companyId = req.customer?.companyId || req.customer?.company_id;

    if (!customerId || !companyId) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Missing customer or company context' });
    }

    const result = await pool.query(
      `SELECT * FROM customer_machines WHERE id::text = $1::text AND company_id::text = $2::text AND customer_id::text = $3::text`,
      [id, companyId, customerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Machine not found' });
    }

    res.json({ success: true, machine: result.rows[0] });
  } catch (err) {
    console.error('❌ Error fetching customer machine details:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ─── GET /api/customer/machines/:id/timeline (Machine timeline) ────────────
router.get('/:id/timeline', async (req, res) => {
  try {
    const { id } = req.params;
    const customerId = req.customer?.id || req.customer?.userId;
    const companyId = req.customer?.companyId || req.customer?.company_id;

    if (!customerId || !companyId) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Missing customer or company context' });
    }

    const machCheck = await pool.query(
      `SELECT id FROM customer_machines WHERE id::text = $1::text AND company_id::text = $2::text AND customer_id::text = $3::text`,
      [id, companyId, customerId]
    );

    if (machCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Machine not found' });
    }

    // Fetch timeline events for this machine
    const events = await pool.query(
      `SELECT id, title, description, created_at as timestamp, 'completed' as status
       FROM machine_timeline_events
       WHERE machine_id::text = $1::text AND company_id::text = $2::text
       ORDER BY created_at DESC`,
      [id, companyId]
    ).catch(() => ({ rows: [] }));

    res.json({
      success: true,
      timeline: events.rows.length > 0 ? events.rows : [
        {
          id: '1',
          title: 'Machine Registered',
          description: 'CNC Machine registered into SmartERP customer registry',
          timestamp: new Date().toISOString(),
          status: 'completed',
        },
      ],
    });
  } catch (err) {
    res.json({ success: true, timeline: [] });
  }
});

module.exports = router;
