/**
 * routes/customers.js
 *
 * REST Endpoints for Company Customer Management (Staff & Owner context).
 * Exposes /api/customers and /api/v1/customers for tenant quotations, remote support,
 * customer directories, and dropdown selection.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

router.use(authenticateToken);

/**
 * GET /api/customers
 * Returns all active customers for the authenticated tenant company.
 * Query params:
 *   - q: text filter across name, email, phone
 *   - limit: maximum rows (default 100, max 500)
 */
router.get('/', async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) {
      return res.status(401).json({ success: false, error: 'Company context is required.' });
    }

    const { q, limit = 100 } = req.query;
    const maxLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);

    let query = `
      SELECT id, name, email, phone, company_id, created_at
      FROM customers
      WHERE company_id::text = $1::text
        AND (is_deleted IS NOT TRUE)
    `;
    const params = [String(companyId)];

    if (q && String(q).trim()) {
      params.push(`%${String(q).trim()}%`);
      query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`;
    }

    query += ` ORDER BY name ASC LIMIT $${params.length + 1}`;
    params.push(maxLimit);

    const result = await pool.query(query, params);

    return res.json({
      success: true,
      customers: result.rows,
      total: result.rowCount,
    });
  } catch (err) {
    console.error('GET /api/customers error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/customers/:id
 * Retrieves a single customer by ID within the authenticated tenant.
 */
router.get('/:id', async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { id } = req.params;

    const result = await pool.query(
      `SELECT id, name, email, phone, company_id, created_at
       FROM customers
       WHERE id::text = $1::text
         AND company_id::text = $2::text
         AND (is_deleted IS NOT TRUE)
       LIMIT 1`,
      [String(id), String(companyId)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    return res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    console.error('GET /api/customers/:id error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/customers
 * Creates a new customer record under the authenticated tenant company.
 */
router.post('/', async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) {
      return res.status(401).json({ success: false, error: 'Company context is required.' });
    }

    const { name, phone, email } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Customer name is required.' });
    }

    const emailVal = email && email.trim() ? email.trim().toLowerCase() : `client_${Date.now()}@direct.local`;

    const result = await pool.query(
      `INSERT INTO customers (company_id, name, email, phone)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, phone, company_id, created_at`,
      [companyId, name.trim(), emailVal, phone ? phone.trim() : null]
    );

    return res.status(201).json({
      success: true,
      customer: result.rows[0],
    });
  } catch (err) {
    console.error('POST /api/customers error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
