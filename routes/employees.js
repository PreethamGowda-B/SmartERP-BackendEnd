const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db'); // ✅ correct

const { authenticateToken } = require('../middleware/authMiddleware');

const DEV = process.env.DEV_ALLOW_UNAUTH_USERS === 'true';

async function mapRowToEmployee(row) {
  // derive a display name from the email if no explicit name column exists
  const email = row.email || '';
  const local = email.split('@')[0] || '';
  const name = local.replace('.', ' ').replace('_', ' ');
  return {
    id: row.id,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    email: row.email,
    phone: row.phone || '',
    position: row.position || 'Employee',
    status: row.is_active === false ? 'inactive' : 'active',
    currentJob: null,
    hoursThisWeek: 0,
    location: row.location || 'Unassigned',
    avatar: '/placeholder-user.jpg',
  };
}

// GET /api/employees - list employees
if (DEV) {
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT u.id, u.email, u.role, u.company_id, p.phone, p.position, p.department, p.hire_date, p.is_active, p.created_at AS profile_created_at
         FROM users u
         LEFT JOIN employee_profiles p ON u.id = p.user_id
         ORDER BY u.id`);
      const employees = await Promise.all(result.rows.map(mapRowToEmployee));
      res.json(employees);
    } catch (err) {
      console.error('Error fetching employees:', err);
      res.status(500).json({ message: 'Server error fetching employees' });
    }
  });

  // POST /api/employees - create employee (dev-unprotected)
  router.post('/', async (req, res) => {
    const { email, password, position, phone } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });
    try {
      const pwd = password || 'ChangeMe123!';
      const hash = await bcrypt.hash(pwd, 10);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const insertUser = await client.query(
          'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email',
          [email, hash, 'user']
        );
        const userId = insertUser.rows[0].id;
        await client.query(
          'INSERT INTO employee_profiles (user_id, phone, position) VALUES ($1, $2, $3)',
          [userId, phone || null, position || null]
        );
        await client.query('COMMIT');
        const employee = await mapRowToEmployee({ id: userId, email, phone, position, is_active: true });
        res.json(employee);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creating employee:', err);
        res.status(500).json({ message: 'Server error creating employee' });
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Error hashing password:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

} else {
  // Protected versions - require authentication
  router.get('/', authenticateToken, async (req, res) => {
    try {
      // ✅ Filter employees by company_id
      const result = await pool.query(
        `SELECT u.id, u.email, u.role, u.company_id, p.phone, p.position, p.department, p.hire_date, p.is_active, p.created_at AS profile_created_at
         FROM users u
         LEFT JOIN employee_profiles p ON u.id = p.user_id
         WHERE u.company_id = $1
         ORDER BY u.id`,
        [req.user.companyId]);
      const employees = await Promise.all(result.rows.map(mapRowToEmployee));
      res.json(employees);
    } catch (err) {
      console.error('Error fetching employees:', err);
      res.status(500).json({ message: 'Server error fetching employees' });
    }
  });

  router.post('/', authenticateToken, async (req, res) => {
    const { email, password, position, phone } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
    try {
      const hash = await bcrypt.hash(password, 10);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // ✅ Add company_id when creating employee
        const insertUser = await client.query(
          'INSERT INTO users (email, password_hash, role, company_id) VALUES ($1, $2, $3, $4) RETURNING id, email',
          [email, hash, 'employee', req.user.companyId]
        );
        const userId = insertUser.rows[0].id;
        await client.query(
          'INSERT INTO employee_profiles (user_id, phone, position, company_id) VALUES ($1, $2, $3, $4)',
          [userId, phone || null, position || null, req.user.companyId]
        );
        await client.query('COMMIT');
        const employee = await mapRowToEmployee({ id: userId, email, phone, position, is_active: true });
        res.json(employee);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creating employee:', err);
        res.status(500).json({ message: 'Server error creating employee' });
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Error hashing password:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
}

module.exports = router;
