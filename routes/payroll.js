const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── POST /api/payroll ───────────────────────────────────────────────────────
// Create new payroll record (Owner only)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { role, userId } = req.user;

    // Only owners can create payroll
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ message: 'Only owners can create payroll records' });
    }

    const {
      employee_email,
      payroll_month,
      payroll_year,
      base_salary,
      extra_amount = 0,
      salary_increment = 0,
      deduction = 0,
      remarks = null
    } = req.body;

    // Validate required fields
    if (!employee_email || !payroll_month || !payroll_year || !base_salary) {
      return res.status(400).json({
        message: 'Missing required fields: employee_email, payroll_month, payroll_year, base_salary'
      });
    }

    // Validate employee exists and get their details
    const employeeResult = await pool.query(
      `SELECT id, name, email FROM users WHERE email = $1 AND role = 'employee'`,
      [employee_email]
    );

    if (employeeResult.rows.length === 0) {
      return res.status(404).json({
        message: 'Employee not found with this email address'
      });
    }

    const employee = employeeResult.rows[0];

    // Calculate total salary
    const total_salary = parseFloat(base_salary) +
      parseFloat(extra_amount) +
      parseFloat(salary_increment) -
      parseFloat(deduction);

    // Check if payroll already exists for this employee and period
    const existingPayroll = await pool.query(
      `SELECT id FROM payroll 
             WHERE employee_id = $1 AND payroll_month = $2 AND payroll_year = $3`,
      [employee.id, payroll_month, payroll_year]
    );

    if (existingPayroll.rows.length > 0) {
      return res.status(409).json({
        message: `Payroll already exists for ${employee_email} for ${payroll_month}/${payroll_year}`
      });
    }

    // Create payroll record
    const result = await pool.query(
      `INSERT INTO payroll 
             (employee_email, employee_id, employee_name, payroll_month, payroll_year, 
              base_salary, extra_amount, salary_increment, deduction, total_salary, 
              remarks, created_by, created_at, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW()) 
             RETURNING *`,
      [
        employee.email,
        employee.id,
        employee.name,
        payroll_month,
        payroll_year,
        base_salary,
        extra_amount,
        salary_increment,
        deduction,
        total_salary,
        remarks,
        userId
      ]
    );

    console.log(`✅ Payroll created for ${employee_email} - ${payroll_month}/${payroll_year}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error creating payroll:', err);
    res.status(500).json({ message: 'Server error creating payroll' });
  }
});

// ─── GET /api/payroll ────────────────────────────────────────────────────────
// Get payroll records (Owner sees all, Employee sees only their own)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { role, userId } = req.user;
    const { month, year, employee_email } = req.query;

    let query;
    let params;

    if (role === 'owner' || role === 'admin') {
      // Owner sees all payroll records
      query = `SELECT * FROM payroll WHERE 1=1`;
      params = [];

      // Add optional filters
      if (month) {
        params.push(month);
        query += ` AND payroll_month = $${params.length}`;
      }
      if (year) {
        params.push(year);
        query += ` AND payroll_year = $${params.length}`;
      }
      if (employee_email) {
        params.push(employee_email);
        query += ` AND employee_email = $${params.length}`;
      }

      query += ` ORDER BY payroll_year DESC, payroll_month DESC, created_at DESC`;
    } else {
      // Employee sees only their own payroll
      query = `SELECT * FROM payroll WHERE employee_id = $1`;
      params = [userId];

      // Add optional filters
      if (month) {
        params.push(month);
        query += ` AND payroll_month = $${params.length}`;
      }
      if (year) {
        params.push(year);
        query += ` AND payroll_year = $${params.length}`;
      }

      query += ` ORDER BY payroll_year DESC, payroll_month DESC`;
    }

    const result = await pool.query(query, params);
    console.log(`✅ Fetched ${result.rows.length} payroll records for ${role}`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching payroll:', err);
    res.status(500).json({ message: 'Server error fetching payroll' });
  }
});

// ─── GET /api/payroll/employees ──────────────────────────────────────────────
// Get list of employees for payroll creation (Owner only)
router.get('/employees', authenticateToken, async (req, res) => {
  try {
    const { role } = req.user;

    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT id, name, email FROM users WHERE role = 'employee' ORDER BY name ASC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching employees:', err);
    res.status(500).json({ message: 'Server error fetching employees' });
  }
});

module.exports = router;