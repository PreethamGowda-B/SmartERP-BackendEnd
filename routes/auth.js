// back/routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const logActivity = require('../helpers/logActivity');
require('dotenv').config();

const ACCESS_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || ACCESS_SECRET;

// Simple signup example
router.post('/signup', async (req, res) => {
  if (!pool) {
    console.error('auth.signup: DB pool undefined');
    return res.status(500).json({ error: 'Database not ready' });
  }

  const { name, email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  try {
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id, email, name;`,
      [name || null, email, hashed]
    );

    logActivity(result.rows[0].id, 'signup', { email });

    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error('auth.signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// Simple login example (returns JWT)
router.post('/login', async (req, res) => {
  if (!pool) {
    console.error('auth.login: DB pool undefined');
    return res.status(500).json({ error: 'Database not ready' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  try {
    const userRes = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    const user = userRes.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const accessToken = jwt.sign({ userId: user.id }, ACCESS_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ userId: user.id }, REFRESH_SECRET, { expiresIn: '7d' });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ accessToken, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('auth.login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/', (req, res) => res.json({ message: 'Auth API working fine ✅' }));

module.exports = router;
