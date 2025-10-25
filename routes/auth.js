// backend/routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const logActivity = require('../helpers/logActivity');
require('dotenv').config();

const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
const ACCESS_EXPIRES = '15m';
const REFRESH_EXPIRES = '7d';

// Simple helper to validate email/password
function validateAuthInput(email, password) {
  if (!email || typeof email !== 'string') return 'Email is required';
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < 6) return 'Password must be at least 6 characters';
  // Optionally add a regex email validation here
  return null;
}

// --------------------
// REGISTER (SIGNUP) ROUTE
// --------------------
router.post('/register', async (req, res) => {
  try {
    const { email, password, role = 'employee' } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();

    const validationError = validateAuthInput(normalizedEmail, password);
    if (validationError) return res.status(400).json({ message: validationError });

    // Hash password
    const hash = await bcrypt.hash(password, 10);

    // Try insert with ON CONFLICT to avoid race conditions
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (LOWER(email)) DO NOTHING
       RETURNING id, email, role;`,
      [normalizedEmail, hash, role]
    );

    if (result.rows.length === 0) {
      // user already exists
      return res.status(409).json({ message: 'Email already registered', existing: true });
    }

    const user = result.rows[0];

    // Log registration activity (if helper tolerates null req.ip etc.)
    try { await logActivity(user.id, 'register', req); } catch (e) { console.warn('logActivity failed', e); }

    return res.status(201).json({ ok: true, user });
  } catch (err) {
    console.error('Register error', err);
    return res.status(500).json({ message: 'Server error during registration' });
  }
});

// --------------------
// LOGIN ROUTE
// --------------------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();

    const validationError = validateAuthInput(normalizedEmail, password);
    if (validationError) return res.status(400).json({ message: validationError });

    const userResult = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const user = userResult.rows[0];

    // Compare password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Log login
    try { await logActivity(user.id, 'login', req); } catch (e) { console.warn('logActivity failed', e); }

    // Tokens
    const accessToken = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: ACCESS_EXPIRES });
    const refreshToken = jwt.sign({ userId: user.id }, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES });

    // Save refresh token
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')',
      [user.id, refreshToken]
    );

    // Cookies
    const cookieOptions = { httpOnly: true, sameSite: 'lax' };
    res.cookie('access_token', accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
    res.cookie('refresh_token', refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });

    return res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    console.error('Login error', err);
    return res.status(500).json({ message: 'Server error during login' });
  }
});

// --------------------
// REFRESH TOKEN ROUTE
// --------------------
router.post('/refresh', async (req, res) => {
  const token = req.cookies?.refresh_token;
  if (!token) return res.status(401).json({ message: 'No refresh token' });

  try {
    const rt = await pool.query('SELECT * FROM refresh_tokens WHERE token = $1', [token]);
    if (rt.rows.length === 0) return res.status(401).json({ message: 'Invalid refresh token' });

    jwt.verify(token, REFRESH_SECRET, async (err, payload) => {
      if (err) return res.status(403).json({ message: 'Invalid token' });

      // Rotate refresh token
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
      const newRefresh = jwt.sign({ userId: payload.userId }, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES });
      await pool.query(
        'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')',
        [payload.userId, newRefresh]
      );

      const accessToken = jwt.sign({ userId: payload.userId }, process.env.JWT_SECRET, { expiresIn: ACCESS_EXPIRES });

      res.cookie('access_token', accessToken, { httpOnly: true, sameSite: 'lax', maxAge: 15 * 60 * 1000 });
      res.cookie('refresh_token', newRefresh, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });

      try { await logActivity(payload.userId, 'refresh_token', req); } catch (e) { console.warn('logActivity failed', e); }
      return res.json({ ok: true });
    });
  } catch (err) {
    console.error('Refresh error', err);
    return res.status(500).json({ message: 'Server error during refresh' });
  }
});

// --------------------
// LOGOUT ROUTE
// --------------------
router.post('/logout', async (req, res) => {
  try {
    const token = req.cookies?.refresh_token;
    if (token) {
      const rt = await pool.query('SELECT * FROM refresh_tokens WHERE token = $1', [token]);
      if (rt.rows.length) {
        const userId = rt.rows[0].user_id;
        try { await logActivity(userId, 'logout', req); } catch (e) { console.warn('logActivity failed', e); }
      }
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
    }

    res.clearCookie('access_token');
    res.clearCookie('refresh_token');
    return res.json({ ok: true });
  } catch (err) {
    console.error('Logout error', err);
    return res.status(500).json({ message: 'Server error during logout' });
  }
});

// --------------------
// TEST ROUTE
// --------------------
router.get('/', (req, res) => {
  res.json({ message: 'Auth route working ✅' });
});

module.exports = router;
