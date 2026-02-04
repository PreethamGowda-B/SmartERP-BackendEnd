const express = require('express');
const router = express.Router();
const { pool } = require('../db');

const { authenticateToken } = require('../middleware/authMiddleware');

// Simple employee management - no user accounts, just employee records

// ─── GET /api/employees-simple ──────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, email, phone, position, department, hire_date, is_active, created_at
       FROM employee_profiles
       ORDER BY created_at DESC`
        );

        const employees = result.rows.map(row => ({
            id: row.id,
            name: row.name || 'Unknown',
            email: row.email || '',
            phone: row.phone || '',
            position: row.position || 'Employee',
            department: row.department || '',
            status: row.is_active === false ? 'inactive' : 'active',
            hireDate: row.hire_date,
            currentJob: null,
            hoursThisWeek: 0,
            location: 'Unassigned',
            avatar: '/placeholder-user.jpg',
        }));

        res.json(employees);
    } catch (err) {
        console.error('Error fetching employees:', err);
        res.status(500).json({ message: 'Server error fetching employees' });
    }
});

// ─── POST /api/employees-simple ─────────────────────────────────────────────
router.post('/', authenticateToken, async (req, res) => {
    // Role guard
    const role = req.user?.role;
    if (role !== 'owner' && role !== 'admin') {
        return res.status(403).json({ message: 'Only owners can create employees' });
    }

    const { name, email, phone, position, department } = req.body;

    if (!name) return res.status(400).json({ message: 'Name is required' });
    if (!email) return res.status(400).json({ message: 'Email is required' });

    try {
        // Check for duplicate email
        const existing = await pool.query(
            'SELECT id FROM employee_profiles WHERE email = $1',
            [email]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({ message: 'An employee with this email already exists' });
        }

        const result = await pool.query(
            `INSERT INTO employee_profiles (name, email, phone, position, department, hire_date, is_active)
       VALUES ($1, $2, $3, $4, $5, NOW(), true)
       RETURNING id, name, email, phone, position, department, hire_date, is_active, created_at`,
            [name, email, phone || null, position || null, department || null]
        );

        const row = result.rows[0];
        const employee = {
            id: row.id,
            name: row.name,
            email: row.email,
            phone: row.phone || '',
            position: row.position || 'Employee',
            department: row.department || '',
            status: 'active',
            hireDate: row.hire_date,
            currentJob: null,
            hoursThisWeek: 0,
            location: 'Unassigned',
            avatar: '/placeholder-user.jpg',
        };

        res.status(201).json(employee);
    } catch (err) {
        console.error('Error creating employee:', err);
        res.status(500).json({ message: 'Server error creating employee' });
    }
});

// ─── DELETE /api/employees-simple/:id ───────────────────────────────────────
router.delete('/:id', authenticateToken, async (req, res) => {
    const role = req.user?.role;
    if (role !== 'owner' && role !== 'admin') {
        return res.status(403).json({ message: 'Only owners can delete employees' });
    }

    const employeeId = parseInt(req.params.id, 10);
    if (isNaN(employeeId)) {
        return res.status(400).json({ message: 'Invalid employee ID' });
    }

    try {
        const result = await pool.query(
            'DELETE FROM employee_profiles WHERE id = $1 RETURNING id',
            [employeeId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        res.status(200).json({ message: 'Employee deleted successfully' });
    } catch (err) {
        console.error('Error deleting employee:', err);
        res.status(500).json({ message: 'Server error deleting employee' });
    }
});

module.exports = router;
