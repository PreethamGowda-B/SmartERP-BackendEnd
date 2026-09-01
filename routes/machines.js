const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/machines (List machines) ──────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && req.user.role !== 'super_admin') {
      return res.json({ success: true, machines: [] });
    }
    const { customer_id, plant_id, status, search } = req.query;

    let query = `
      SELECT m.*, COALESCE(c.name, c.email, 'Customer') as customer_name, COALESCE(p.plant_name, 'Main Plant') as plant_name
      FROM customer_machines m
      LEFT JOIN customers c ON m.customer_id::text = c.id::text
      LEFT JOIN customer_plants p ON m.plant_id::text = p.id::text
      WHERE m.company_id::text = $1::text
    `;
    const params = [companyId];

    if (customer_id) {
      params.push(customer_id);
      query += ` AND m.customer_id::text = $${params.length}::text`;
    }

    if (plant_id) {
      params.push(plant_id);
      query += ` AND m.plant_id::text = $${params.length}::text`;
    }

    if (status) {
      params.push(status);
      query += ` AND m.status = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (m.machine_name ILIKE $${params.length} OR m.serial_number ILIKE $${params.length} OR m.make ILIKE $${params.length} OR m.model ILIKE $${params.length} OR m.controller_type ILIKE $${params.length})`;
    }

    query += ` ORDER BY m.created_at DESC`;

    const result = await pool.query(query, params).catch(async (err) => {
      console.warn("⚠️ Query customer_machines with joins failed, falling back to simple query:", err.message);
      return pool.query(`SELECT * FROM customer_machines WHERE company_id::text = $1::text ORDER BY created_at DESC`, [companyId]).catch(() => ({ rows: [] }));
    });

    // 🛡️ M-1 Fix: Strip machine serial numbers for non-owner/technician roles
    const machines = (result.rows || []).map(m => {
      if (req.user.role === 'employee') {
        const { serial_number, ...safeMachine } = m;
        return safeMachine;
      }
      return m;
    });

    res.json({ success: true, machines });
  } catch (err) {
    console.error('❌ Error fetching machines:', err.message);
    res.json({ success: true, machines: [] });
  }
});

// ─── POST /api/machines (Register new CNC machine) ──────────────────────────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) return res.status(403).json({ message: 'No company associated with this account' });
    const {
      customer_id,
      plant_id,
      production_line,
      area_location,
      machine_name,
      make,
      model,
      serial_number,
      controller_type,
      year_of_manufacture,
      spindle_hours = 0,
      installation_date,
      warranty_expiry,
      ip_address,
      iot_device_id,
      status = 'operational',
      health_score = 100,
      critical_level = 'medium',
      amc_contract_number
    } = req.body;

    if (!customer_id || !machine_name || !serial_number) {
      return res.status(400).json({ message: 'customer_id, machine_name, and serial_number are required' });
    }

    const result = await pool.query(
      `INSERT INTO customer_machines (
        company_id, customer_id, plant_id, production_line, area_location,
        machine_name, make, model, serial_number, controller_type,
        year_of_manufacture, spindle_hours, installation_date, warranty_expiry,
        ip_address, iot_device_id, status, health_score, critical_level, amc_contract_number
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20
      ) RETURNING *`,
      [
        companyId, customer_id, plant_id || null, production_line || null, area_location || null,
        machine_name, make || null, model || null, serial_number, controller_type || null,
        year_of_manufacture || null, spindle_hours, installation_date || null, warranty_expiry || null,
        ip_address || null, iot_device_id || null, status, health_score, critical_level, amc_contract_number || null
      ]
    );

    res.status(201).json({ success: true, machine: result.rows[0] });
  } catch (err) {
    console.error('❌ Error creating machine:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── GET /api/machines/:id (Fetch machine profile & dashboard details) ──────
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) return res.status(403).json({ message: 'No company associated with this account' });
    const { id } = req.params;

    const machineRes = await pool.query(
      `SELECT m.*, c.name as customer_name, p.plant_name
       FROM customer_machines m
       LEFT JOIN customers c ON m.customer_id::text = c.id::text
       LEFT JOIN customer_plants p ON m.plant_id::text = p.id::text
       WHERE m.id::text = $1::text AND m.company_id::text = $2::text`,
      [id, companyId]
    );

    if (machineRes.rows.length === 0) {
      return res.status(404).json({ message: 'Machine not found' });
    }

    const machine = machineRes.rows[0];

    // Fetch Sub-Components
    const subsRes = await pool.query(
      `SELECT * FROM machine_subcomponents WHERE machine_id::text = $1::text ORDER BY created_at ASC`,
      [id]
    ).catch(() => ({ rows: [] }));

    // Fetch Documents
    const docsRes = await pool.query(
      `SELECT * FROM customer_machine_documents WHERE machine_id::text = $1::text ORDER BY created_at DESC`,
      [id]
    ).catch(() => ({ rows: [] }));

    // Fetch Recent Jobs & Active Job
    const jobsRes = await pool.query(
      `SELECT id, title, status, service_type, alarm_code, created_at FROM jobs WHERE machine_id::text = $1::text ORDER BY created_at DESC LIMIT 10`,
      [id]
    ).catch(() => ({ rows: [] }));

    // Fetch AMC Contract
    const amcRes = await pool.query(
      `SELECT * FROM amc_contracts WHERE customer_id::text = $1::text AND status = 'active' ORDER BY end_date DESC LIMIT 1`,
      [machine.customer_id]
    ).catch(() => ({ rows: [] }));

    // Fetch Alarm History
    const alarmsRes = await pool.query(
      `SELECT alarm_code, controller_type, count(*) as frequency, max(created_at) as last_occurred FROM jobs WHERE machine_id::text = $1::text AND alarm_code IS NOT NULL AND alarm_code != '' GROUP BY alarm_code, controller_type ORDER BY frequency DESC`,
      [id]
    ).catch(() => ({ rows: [] }));

    // Fetch Remote Support Sessions
    const remoteRes = await pool.query(
      `SELECT * FROM remote_support_sessions WHERE machine_id::text = $1::text ORDER BY created_at DESC LIMIT 10`,
      [id]
    ).catch(() => ({ rows: [] }));

    res.json({
      success: true,
      machine: {
        ...machine,
        subcomponents: subsRes.rows,
        documents: docsRes.rows,
        recent_jobs: jobsRes.rows,
        active_job: jobsRes.rows.find((j) => j.status === 'in_progress' || j.status === 'open' || j.status === 'assigned') || null,
        amc_contract: amcRes.rows[0] || null,
        alarm_history: alarmsRes.rows,
        remote_sessions: remoteRes.rows,
      },
    });
  } catch (err) {
    console.error('❌ Error fetching machine profile:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── GET /api/machines/:id/timeline (Fetch machine 17-step timeline) ─────────
router.get('/:id/timeline', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM machine_timeline_events WHERE machine_id::text = $1::text ORDER BY created_at DESC LIMIT 50`,
      [id]
    );
    res.json({ success: true, timeline: result.rows });
  } catch (err) {
    console.error('❌ Error fetching machine timeline:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── POST /api/machines/:id/subcomponents (Add subcomponent) ─────────────────
router.post('/:id/subcomponents', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) return res.status(403).json({ message: 'No company associated with this account' });
    const { id } = req.params;
    const { component_type, name, make_model, serial_number, specs } = req.body;

    if (!component_type || !name) {
      return res.status(400).json({ message: 'component_type and name are required' });
    }

    const result = await pool.query(
      `INSERT INTO machine_subcomponents (company_id, machine_id, component_type, name, make_model, serial_number, specs, installed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [companyId, id, component_type, name, make_model || null, serial_number || null, JSON.stringify(specs || {})]
    );

    res.status(201).json({ success: true, subcomponent: result.rows[0] });
  } catch (err) {
    console.error('❌ Error adding subcomponent:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
