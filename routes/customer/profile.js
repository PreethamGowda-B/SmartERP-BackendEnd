/**
 * routes/customer/profile.js
 *
 * Customer Portal profile routes — all protected by authenticateCustomer.
 *
 *   GET /  — get own profile
 *   PUT /  — update name and/or phone (email is immutable)
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { pool } = require('../../db');

// ─── GET / — get own profile ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const customerId = req.customer.id;

  try {
    const result = await pool.query(
      `SELECT
         id, name, email, phone, company_id,
         auth_provider, is_verified, created_at
       FROM customers
       WHERE id = $1`,
      [customerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    // password_hash is never returned
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('customer profile GET error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ─── PUT / — update name and/or phone ────────────────────────────────────────
router.put('/', [
  body('name').optional({ checkFalsy: true }).trim().notEmpty().withMessage('Name cannot be empty'),
  body('phone').optional({ checkFalsy: true }).trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
  }

  const customerId = req.customer.id;

  // Strip email from body — email changes are not permitted
  const { name, phone } = req.body;

  // Build parameterized UPDATE dynamically
  const setClauses = [];
  const values = [];
  let idx = 1;

  if (name !== undefined) {
    setClauses.push('name = $' + idx);
    values.push(name);
    idx++;
  }
  if (phone !== undefined) {
    setClauses.push('phone = $' + idx);
    values.push(phone);
    idx++;
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ message: 'No fields to update' });
  }

  // customer id is the last parameter
  values.push(customerId);
  const whereClause = '$' + idx;

  try {
    const result = await pool.query(
      'UPDATE customers SET ' + setClauses.join(', ') +
      ' WHERE id = ' + whereClause +
      ' RETURNING id, name, email, phone, company_id, auth_provider, is_verified, created_at',
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('customer profile PUT error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
