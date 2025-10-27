// back/routes/employees.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /employees - list employees (example)
router.get('/', async (req, res) => {
  if (!pool) {
    console.error('employees.get: DB pool undefined');
    return res.status(500).json({ error: 'Database not ready' });
  }

  try {
    const result = await pool.query('SELECT id, name, email, position FROM employees ORDER BY id DESC LIMIT 200;');
    res.json({ employees: result.rows });
  } catch (err) {
    console.error('employees.get error:', err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// POST /employees - create a simple employee (example)
router.post('/', async (req, res) => {
  if (!pool) {
    console.error('employees.post: DB pool undefined');
    return res.status(500).json({ error: 'Database not ready' });
  }

  const { name, email, position } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO employees (name, email, position, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id, name, email, position;`,
      [name, email, position || null]
    );
    res.status(201).json({ employee: result.rows[0] });
  } catch (err) {
    console.error('employees.post error:', err);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

module.exports = router;
