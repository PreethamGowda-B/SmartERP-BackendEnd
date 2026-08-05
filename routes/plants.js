const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/plants ────────────────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;
    const { customer_id } = req.query;

    let query = `SELECT * FROM customer_plants WHERE company_id::text = $1::text`;
    const params = [companyId];

    if (customer_id) {
      params.push(customer_id);
      query += ` AND customer_id::text = $${params.length}::text`;
    }

    query += ` ORDER BY plant_name ASC`;

    const result = await pool.query(query, params);
    res.json({ success: true, plants: result.rows });
  } catch (err) {
    console.error('❌ Error fetching plants:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── POST /api/plants ───────────────────────────────────────────────────────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;
    const { customer_id, plant_name, code, address, contact_person, contact_phone } = req.body;

    if (!customer_id || !plant_name) {
      return res.status(400).json({ message: 'customer_id and plant_name are required' });
    }

    const result = await pool.query(
      `INSERT INTO customer_plants (company_id, customer_id, plant_name, code, address, contact_person, contact_phone, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [companyId, customer_id, plant_name, code || null, address || null, contact_person || null, contact_phone || null]
    );

    res.status(201).json({ success: true, plant: result.rows[0] });
  } catch (err) {
    console.error('❌ Error creating plant:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
