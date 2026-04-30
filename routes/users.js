/**
 * routes/users.js — HARDENED
 *
 * - Role guard: only owner/admin can create users
 * - Tenant scoped: company_id attached to new user from the creator
 * - GET /me uses correct field (userId vs id)
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

function requireOwnerOrAdmin(req, res, next) {
  if (!['owner', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ success: false, error: 'Only owners or admins can create users' });
  }
  next();
}

// Create user — owner/admin only, tied to creator's company
router.post('/', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const { email, password, role, name } = req.body;
  const companyId = req.user.companyId;

  const allowedRoles = ['employee', 'admin', 'hr'];
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'email and password are required' });
  }
  if (role && !allowedRoles.includes(role)) {
    return res.status(400).json({ success: false, error: `Invalid role. Allowed: ${allowedRoles.join(', ')}` });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, role, name, company_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role, name',
      [email.toLowerCase().trim(), hash, role || 'employee', name || null, companyId]
    );
    res.status(201).json({ success: true, data: result.rows[0], error: null });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'Email already exists' });
    }
    console.error('users POST error:', err.message);
    res.status(500).json({ success: false, error: 'Server error creating user' });
  }
});

// Get current user — company-scoped context
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const result = await pool.query(
      'SELECT id, email, role, name, company_id, created_at FROM users WHERE id = $1',
      [userId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, data: result.rows[0], error: null });
  } catch (err) {
    console.error('users GET /me error:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;