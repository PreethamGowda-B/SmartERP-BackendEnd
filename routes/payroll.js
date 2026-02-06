const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createNotification } = require('../utils/notificationHelpers');

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

    // ─── FETCH ATTENDANCE SUMMARY ────────────────────────────────────────────
    const attendanceResult = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE status = 'present') as present_days,
        COUNT(*) FILTER (WHERE status = 'absent') as absent_days,
        COUNT(*) FILTER (WHERE status = 'half_day') as half_days,
        COALESCE(SUM(working_hours), 0) as total_hours
       FROM attendance
       WHERE user_id = $1 
         AND EXTRACT(MONTH FROM date) = $2
         AND EXTRACT(YEAR FROM date) = $3`,
      [employee.id, payroll_month, payroll_year]
    );

    const attendanceSummary = attendanceResult.rows[0] || {
      present_days: 0,
      absent_days: 0,
      half_days: 0,
      total_hours: 0
    };

    const presentDays = parseInt(attendanceSummary.present_days) || 0;
    const absentDays = parseInt(attendanceSummary.absent_days) || 0;
    const halfDays = parseInt(attendanceSummary.half_days) || 0;
    const totalHours = parseFloat(attendanceSummary.total_hours) || 0;

    // Calculate payable days (half days count as 0.5)
    const payableDays = presentDays + (halfDays * 0.5);

    // Assume 26 working days per month (adjust as needed)
    const totalWorkingDays = 26;

    // Adjust base salary based on attendance
    const attendanceAdjustedSalary = (parseFloat(base_salary) / totalWorkingDays) * payableDays;

    // Calculate total salary with adjustments
    const total_salary = attendanceAdjustedSalary +
      parseFloat(extra_amount) +
      parseFloat(salary_increment) -
      parseFloat(deduction);

    console.log(`📊 Payroll for ${employee.email}: Present=${presentDays}, Absent=${absentDays}, Half=${halfDays}, Payable=${payableDays} days`);
    console.log(`💰 Base: ${base_salary}, Adjusted: ${attendanceAdjustedSalary.toFixed(2)}, Total: ${total_salary.toFixed(2)}`);

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

    // Create payroll record with attendance data
    const result = await pool.query(
      `INSERT INTO payroll 
             (employee_email, employee_id, employee_name, payroll_month, payroll_year, 
              base_salary, extra_amount, salary_increment, deduction, total_salary, 
              present_days, absent_days, half_days, total_working_hours,
              remarks, created_by, created_at, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW()) 
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
        presentDays,
        absentDays,
        halfDays,
        totalHours,
        remarks,
        userId
      ]
    );

    const payrollRecord = result.rows[0];

    // Send notification to employee
    try {
      await createNotification({
        user_id: employee.id,
        company_id: req.user.companyId,
        type: 'payroll',
        title: 'Payroll Received',
        message: `Your payroll for ${payroll_month}/${payroll_year} has been processed. Total: $${total_salary}`,
        priority: 'high',
        data: {
          payroll_id: payrollRecord.id,
          month: payroll_month,
          year: payroll_year,
          total_salary
        }
      });
      console.log(`✅ Notification sent for payroll: ${employee_email} - ${payroll_month}/${payroll_year}`);
    } catch (notifErr) {
      console.error('❌ Failed to send payroll notification:', notifErr);
    }

    console.log(`✅ Payroll created for ${employee_email} - ${payroll_month}/${payroll_year}`);
    res.status(201).json(payrollRecord);
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