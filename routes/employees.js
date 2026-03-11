const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db');

const { authenticateToken } = require('../middleware/authMiddleware');

const DEV = process.env.DEV_ALLOW_UNAUTH_USERS === 'true';

async function mapRowToEmployee(row) {
  // Use actual name from database if available, otherwise derive from email
  let name = row.name;
  if (!name) {
    const email = row.email || '';
    const local = email.split('@')[0] || '';
    name = local.replace('.', ' ').replace('_', ' ');
    name = name.charAt(0).toUpperCase() + name.slice(1);
  }
  return {
    id: row.id,
    name: name,
    email: row.email,
    phone: row.phone || '',
    position: row.position || 'Employee',
    status: row.is_active === false ? 'inactive' : 'active',
    currentJob: null,
    hoursThisWeek: 0,
    location: row.location || 'Unassigned',
    avatar: '/placeholder-user.jpg',
    created_at: row.created_at || null,
    department: row.department || null,
    is_active: row.is_active !== false,
  };
}

// ─── GET /api/employees ─────────────────────────────────────────────────────
router.get('/', DEV ? (req, res, next) => next() : authenticateToken, async (req, res) => {
  try {
    const companyId = req.user?.companyId;
    if (!companyId) {
      return res.status(400).json({ message: 'No company associated with your account' });
    }
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.created_at, p.phone, p.position, p.department, p.hire_date, p.is_active, p.created_at AS profile_created_at
       FROM users u
       LEFT JOIN employee_profiles p ON u.id = p.user_id
       WHERE u.company_id = $1 AND u.role != 'owner' AND u.role != 'admin'
       ORDER BY u.created_at DESC NULLS LAST`,
      [companyId]
    );
    const employees = await Promise.all(result.rows.map(mapRowToEmployee));
    res.json(employees);
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ message: 'Server error fetching employees' });
  }
});

const { body, validationResult } = require('express-validator');

// ─── POST /api/employees ────────────────────────────────────────────────────
router.post('/', DEV ? (req, res, next) => next() : authenticateToken, [
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('name').trim().notEmpty().withMessage('Name is required').escape(),
  body('password').optional({ checkFalsy: true }).isString(),
  body('position').optional({ checkFalsy: true }).trim().escape(),
  body('phone').optional({ checkFalsy: true }).isMobilePhone().withMessage('Invalid phone number').escape()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: "Validation failed", errors: errors.array() });
  }

  // Role guard (skip in DEV mode)
  if (!DEV) {
    const role = req.user?.role;
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ message: 'Only owners can create employees' });
    }
  }

  const { email, password, position, phone, name } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });
  if (!name) return res.status(400).json({ message: 'Name is required' });

  // Auto-generate a secure default password if not provided
  const pwd = password || 'Employee@123';

  try {
    // Check for duplicate email
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }

    const companyId = req.user?.companyId;
    const companyCode = req.user?.companyCode || null;

    if (!companyId) {
      return res.status(400).json({ message: 'No company associated with your account' });
    }

    const hash = await bcrypt.hash(pwd, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insertUser = await client.query(
        'INSERT INTO users (name, email, password_hash, role, company_id, company_code) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email',
        [name, email, hash, 'employee', companyId, companyCode]
      );
      const userId = insertUser.rows[0].id;
      await client.query(
        'INSERT INTO employee_profiles (user_id, phone, position, company_id) VALUES ($1, $2, $3, $4)',
        [userId, phone || null, position || null, companyId]
      );
      await client.query('COMMIT');

      const employee = await mapRowToEmployee({ id: userId, name, email, phone, position, is_active: true });
      res.status(201).json(employee);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error creating employee:', err);
    res.status(500).json({ message: 'Server error creating employee' });
  }
});

// ─── PATCH /api/employees/:id ────────────────────────────────────────────────
// Update employee department, position, and account status
router.patch('/:id', authenticateToken, [
  body('department').optional({ checkFalsy: true }).trim().escape(),
  body('position').optional({ checkFalsy: true }).trim().escape(),
  body('is_active').optional().isBoolean().withMessage('is_active must be a boolean')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: "Validation failed", errors: errors.array() });
  }

  // Only owners / admins can update employees
  const role = req.user?.role;
  if (role !== 'owner' && role !== 'admin') {
    return res.status(403).json({ message: 'Only owners can update employees' });
  }

  const employeeId = req.params.id;
  if (!employeeId) {
    return res.status(400).json({ message: 'Invalid employee ID' });
  }

  const { department, position, is_active } = req.body;

  try {
    // Verify employee exists, belongs to same company, and is not an owner/admin
    const companyId = req.user?.companyId;
    const target = await pool.query('SELECT id, role, company_id FROM users WHERE id = $1', [employeeId]);
    if (target.rows.length === 0) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    if (target.rows[0].role === 'owner' || target.rows[0].role === 'admin') {
      return res.status(403).json({ message: 'Cannot update an owner or admin account' });
    }
    if (String(target.rows[0].company_id) !== String(companyId)) {
      return res.status(403).json({ message: 'Access denied: employee does not belong to your company' });
    }

    // Build update query dynamically based on provided fields
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (department !== undefined) {
      updates.push(`department = $${paramIndex}`);
      values.push(department);
      paramIndex++;
    }

    if (position !== undefined) {
      updates.push(`position = $${paramIndex}`);
      values.push(position);
      paramIndex++;
    }

    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex}`);
      values.push(is_active);
      paramIndex++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    // Add user_id to values
    values.push(employeeId);

    // Update employee_profiles
    const updateQuery = `
      UPDATE employee_profiles 
      SET ${updates.join(', ')}
      WHERE user_id = $${paramIndex}
      RETURNING *
    `;

    await pool.query(updateQuery, values);

    // Fetch updated employee data
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.created_at, p.phone, p.position, p.department, p.hire_date, p.is_active, p.created_at AS profile_created_at
       FROM users u
       LEFT JOIN employee_profiles p ON u.id = p.user_id
       WHERE u.id = $1`,
      [employeeId]
    );

    const employee = await mapRowToEmployee(result.rows[0]);
    res.json(employee);
  } catch (err) {
    console.error('Error updating employee:', err);
    res.status(500).json({ message: 'Server error updating employee' });
  }
});

// ─── DELETE /api/employees/:id ──────────────────────────────────────────────
router.delete('/:id', authenticateToken, async (req, res) => {
  // Only owners / admins can delete employees
  const role = req.user?.role;
  if (role !== 'owner' && role !== 'admin') {
    return res.status(403).json({ message: 'Only owners can delete employees' });
  }

  const employeeId = req.params.id;
  if (!employeeId) {
    return res.status(400).json({ message: 'Invalid employee ID' });
  }

  // Prevent deleting yourself
  if (employeeId === req.user.id || employeeId === req.user.userId) {
    return res.status(400).json({ message: 'You cannot delete your own account' });
  }

  try {
    // Confirm the target user exists, belongs to same company, and is not an owner/admin
    const companyId = req.user?.companyId;
    const target = await pool.query('SELECT id, role, company_id FROM users WHERE id = $1', [employeeId]);
    if (target.rows.length === 0) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    if (target.rows[0].role === 'owner' || target.rows[0].role === 'admin') {
      return res.status(403).json({ message: 'Cannot delete an owner or admin account' });
    }
    if (String(target.rows[0].company_id) !== String(companyId)) {
      return res.status(403).json({ message: 'Access denied: employee does not belong to your company' });
    }

    // employee_profiles has ON DELETE CASCADE, so deleting from users removes the profile too.
    // Also clean up any refresh tokens for this user.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [employeeId]);
      await client.query('DELETE FROM users WHERE id = $1', [employeeId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(200).json({ message: 'Employee deleted successfully' });
  } catch (err) {
    console.error('Error deleting employee:', err);
    res.status(500).json({ message: 'Server error deleting employee' });
  }
});

module.exports = router;
