/**
 * routes/customer/auth.js
 *
 * Customer Portal authentication routes:
 *   GET  /csrf              — issue CSRF token
 *   POST /send-otp          — send OTP to email
 *   POST /verify-otp        — verify OTP
 *   POST /signup            — register new customer
 *   POST /login             — authenticate customer
 *   POST /refresh           — rotate refresh token
 *   POST /logout            — revoke refresh token + clear cookies
 *   GET  /google            — initiate Google OAuth (customer-specific strategy)
 *   GET  /google/callback   — handle Google OAuth callback
 *   POST /onboarding        — complete onboarding (set company_id + phone)
 *   GET  /validate-company  — check if a company code is valid
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Resend } = require('resend');

const { pool } = require('../../db');
const redisClient = require('../../utils/redis');
const { validateCompanyCode } = require('../../utils/companyIdGenerator');

// ─── Constants ────────────────────────────────────────────────────────────────
const CUSTOMER_PORTAL_ORIGIN = process.env.CUSTOMER_PORTAL_ORIGIN || 'http://localhost:3001';
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;

const cookieOpts = { httpOnly: true, sameSite: 'none', secure: true, path: '/' };
const ACCESS_MAX_AGE = 60 * 60 * 1000;        // 1 hour
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Resend client ────────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Audit log helper (non-blocking) ─────────────────────────────────────────
function auditLog(req, customerId, action, details, companyId) {
  pool.query(
    `INSERT INTO activities (user_id, action, activity_type, details, ip_address, user_agent, company_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      customerId || null,
      action,
      'customer_auth',
      JSON.stringify(details || {}),
      req.ip,
      req.get('user-agent'),
      companyId || null,
    ]
  ).catch(e => console.error('Audit log error:', e.message));
}

// ─── Issue full JWT cookies helper ───────────────────────────────────────────
async function issueTokens(res, req, customer) {
  const accessToken = jwt.sign(
    { id: customer.id, role: 'customer', companyId: customer.company_id, email: customer.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const refreshToken = jwt.sign(
    { id: customer.id },
    JWT_REFRESH_SECRET,
    { expiresIn: '30d' }
  );

  // Store refresh token in dedicated customer_refresh_tokens table
  await pool.query(
    `INSERT INTO customer_refresh_tokens
       (customer_id, token, token_family, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', $4, $5)`,
    [
      customer.id,
      refreshToken,
      crypto.randomUUID(),
      req.get('user-agent') || null,
      req.ip || null,
    ]
  );

  // Set cookies
  res.cookie('customer_access_token', accessToken, {
    ...cookieOpts,
    maxAge: ACCESS_MAX_AGE,
  });
  res.cookie('customer_refresh_token', refreshToken, {
    ...cookieOpts,
    maxAge: REFRESH_MAX_AGE,
  });

  // Rotate CSRF token
  const newCsrf = crypto.randomBytes(32).toString('hex');
  res.cookie('csrf_token', newCsrf, {
    httpOnly: false,
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: ACCESS_MAX_AGE,
  });

  return { accessToken, refreshToken };
}

// ─── CSRF validation middleware ───────────────────────────────────────────────
// Applied to all non-GET routes in this router.
// Skipped for: /csrf endpoint, SSE routes, requests with Authorization: Bearer header.
router.use((req, res, next) => {
  // Only protect mutating methods
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  // Skip CSRF for the /csrf endpoint itself
  if (req.path === '/csrf') {
    return next();
  }

  // Skip if Authorization: Bearer is present (API clients)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return next();
  }

  const csrfHeader = req.headers['x-csrf-token'];
  const csrfCookie = req.cookies && req.cookies['csrf_token'];

  // If no cookie yet (first request), allow through — client must call /csrf first
  if (!csrfCookie) {
    return next();
  }

  if (!csrfHeader) {
    return res.status(403).json({ message: 'Invalid CSRF token' });
  }

  try {
    const headerBuf = Buffer.from(csrfHeader, 'utf8');
    const cookieBuf = Buffer.from(csrfCookie, 'utf8');

    if (
      headerBuf.length !== cookieBuf.length ||
      !crypto.timingSafeEqual(headerBuf, cookieBuf)
    ) {
      return res.status(403).json({ message: 'Invalid CSRF token' });
    }
  } catch {
    return res.status(403).json({ message: 'Invalid CSRF token' });
  }

  next();
});

// ─── GET /csrf ────────────────────────────────────────────────────────────────
router.get('/csrf', (req, res) => {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  res.cookie('csrf_token', csrfToken, {
    httpOnly: false,   // Must be readable by JS
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: ACCESS_MAX_AGE,
  });
  return res.json({ csrfToken });
});

// ─── POST /send-otp ───────────────────────────────────────────────────────────
router.post('/send-otp', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: 'Valid email required', errors: errors.array() });
  }

  const { email } = req.body;

  try {
    // Email conflict check — block if email already exists in users table (owner/employee)
    const userConflict = await pool.query(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    if (userConflict.rows.length > 0) {
      auditLog(req, null, 'email_conflict_blocked', { email, source: 'customer_signup' }, null);
      return res.status(409).json({
        message: 'This email is already registered as an employee or owner. Please use a different email to create a customer account.',
      });
    }

    // Redis rate limiting (only if Redis is available)
    if (redisClient && redisClient.status === 'ready') {
      try {
        // 60-second cooldown between requests (Requirement 2.3)
        const cooldownKey = `otp_cooldown:${email}`;
        const cooldown = await redisClient.get(cooldownKey);
        if (cooldown) {
          const ttl = await redisClient.ttl(cooldownKey);
          return res.status(429).json({
            message: 'Please wait before requesting another OTP.',
            retryAfter: ttl > 0 ? ttl : 60,
          });
        }

        // Max 5 OTPs per 10-minute window (Requirement 2.2)
        const countKey = `otp_attempts:${email}`;
        const count = await redisClient.get(countKey);
        if (count && parseInt(count, 10) >= 5) {
          const ttl = await redisClient.ttl(countKey);
          return res.status(429).json({
            message: 'Too many OTP requests. Please try again later.',
            retryAfter: ttl > 0 ? ttl : 600,
          });
        }
      } catch (redisErr) {
        // Redis failure must NOT block OTP sending
        console.warn('OTP rate limit Redis check failed (non-fatal):', redisErr.message);
      }
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete old OTPs for this email, then insert new one
    await pool.query('DELETE FROM email_otps WHERE email = $1', [email]);
    await pool.query(
      `INSERT INTO email_otps (email, otp_code, expires_at, used, created_at)
       VALUES ($1, $2, NOW() + INTERVAL '10 minutes', FALSE, NOW())`,
      [email, otp]
    );

    // Set Redis cooldown and increment count (after DB insert to avoid counting failed sends)
    if (redisClient && redisClient.status === 'ready') {
      try {
        const cooldownKey = `otp_cooldown:${email}`;
        const countKey = `otp_attempts:${email}`;
        await redisClient.set(cooldownKey, '1', 'EX', 60);
        await redisClient.incr(countKey);
        await redisClient.expire(countKey, 600);
      } catch (redisErr) {
        console.warn('OTP Redis counter update failed (non-fatal):', redisErr.message);
      }
    }

    // Send OTP via Resend
    await resend.emails.send({
      from: 'SmartERP <noreply@prozync.in>',
      to: email,
      subject: 'Your SmartERP Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f8fafc; border-radius: 12px;">
          <h2 style="color: #1e293b; text-align: center;">Email Verification</h2>
          <p style="color: #64748b; text-align: center;">Use the code below to verify your email.</p>
          <div style="background: white; border: 2px solid #e2e8f0; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
            <div style="font-size: 42px; font-weight: bold; letter-spacing: 10px; color: #4F46E5; font-family: monospace;">${otp}</div>
          </div>
          <p style="color: #94a3b8; text-align: center; font-size: 13px;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        </div>
      `,
    });

    // Non-blocking audit log
    pool.query(
      `INSERT INTO activities (user_id, activity_type, details, ip_address, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [null, 'otp_request', JSON.stringify({ email }), req.ip]
    ).catch(e => console.error('Audit log error:', e.message));

    return res.json({ ok: true, message: 'OTP sent' });
  } catch (err) {
    console.error('send-otp error:', err.message);
    return res.status(500).json({ message: 'Failed to send OTP. Please try again.' });
  }
});

// ─── POST /verify-otp ─────────────────────────────────────────────────────────
router.post('/verify-otp', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: 'Invalid or expired code.' });
  }

  const { email, otp } = req.body;

  try {
    const result = await pool.query(
      `SELECT id FROM email_otps
       WHERE email = $1
         AND otp_code = $2
         AND used = FALSE
         AND expires_at > NOW()
       LIMIT 1`,
      [email, otp]
    );

    if (result.rows.length === 0) {
      // Non-blocking audit log for OTP failure
      pool.query(
        `INSERT INTO activities (user_id, activity_type, details, ip_address, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [null, 'otp_failure', JSON.stringify({ email }), req.ip]
      ).catch(e => console.error('Audit log error:', e.message));
      return res.status(400).json({ message: 'Invalid or expired code.' });
    }

    // Mark OTP as used
    await pool.query('UPDATE email_otps SET used = TRUE WHERE id = $1', [result.rows[0].id]);

    return res.json({ ok: true, verified: true });
  } catch (err) {
    console.error('verify-otp error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /signup ─────────────────────────────────────────────────────────────
router.post('/signup', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('phone').trim().notEmpty().withMessage('Phone is required'),
  body('company_code').trim().notEmpty().withMessage('Company code is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
  }

  const { name, email, password, phone, company_code } = req.body;

  try {
    // Check verified OTP within 15 minutes
    const otpCheck = await pool.query(
      `SELECT id FROM email_otps
       WHERE email = $1
         AND used = TRUE
         AND created_at > NOW() - INTERVAL '15 minutes'
       LIMIT 1`,
      [email]
    );

    if (otpCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Email not verified. Please verify your email first.' });
    }

    // Validate company code
    const companyResult = await validateCompanyCode(company_code);
    if (!companyResult.valid) {
      return res.status(400).json({ message: 'Invalid company code' });
    }

    const companyId = companyResult.company.id;

    // Check email uniqueness in customers table
    const existingCustomer = await pool.query(
      'SELECT id FROM customers WHERE email = $1',
      [email]
    );
    if (existingCustomer.rows.length > 0) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Re-check users table (final guard before account creation)
    const userConflictFinal = await pool.query(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    if (userConflictFinal.rows.length > 0) {
      auditLog(req, null, 'email_conflict_blocked', { email, source: 'customer_signup' }, null);
      return res.status(409).json({
        message: 'This email is already registered as an employee or owner. Please use a different email to create a customer account.',
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert customer
    const insertResult = await pool.query(
      `INSERT INTO customers (name, email, password_hash, phone, company_id, auth_provider, is_verified)
       VALUES ($1, $2, $3, $4, $5, 'manual', TRUE)
       RETURNING id`,
      [name, email, passwordHash, phone, companyId]
    );

    const customerId = insertResult.rows[0].id;

    // Non-blocking audit log
    auditLog(req, customerId, 'customer_signup', { email, company_id: companyId }, companyId);

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('signup error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /login ──────────────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: 'Invalid credentials' });
  }

  const { email, password } = req.body;
  const ip = req.ip;

  try {
    // Check Redis lockout by email
    if (redisClient && redisClient.status === 'ready') {
      try {
        const emailLockKey = `customer_login_lock:${email}`;
        const ipLockKey = `customer_login_lock_ip:${ip}`;

        const emailLocked = await redisClient.get(emailLockKey);
        if (emailLocked) {
          const ttl = await redisClient.ttl(emailLockKey);
          return res.status(429).json({
            message: 'Too many failed attempts. Please try again in 15 minutes.',
            retryAfter: ttl,
          });
        }

        const ipLocked = await redisClient.get(ipLockKey);
        if (ipLocked) {
          const ttl = await redisClient.ttl(ipLockKey);
          return res.status(429).json({
            message: 'Too many failed attempts. Please try again in 15 minutes.',
            retryAfter: ttl,
          });
        }
      } catch (redisErr) {
        // Redis failure must NOT block login
        console.warn('Login lockout Redis check failed (non-fatal):', redisErr.message);
      }
    }

    // Look up customer
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE email = $1',
      [email]
    );

    // Helper: increment failure counters
    async function incrementFailures() {
      if (!redisClient || redisClient.status !== 'ready') return;
      try {
        const emailCountKey = `customer_login_fail_count:${email}`;
        const ipCountKey = `customer_login_fail_count_ip:${ip}`;

        const emailCount = await redisClient.incr(emailCountKey);
        await redisClient.expire(emailCountKey, 900);
        if (emailCount >= 5) {
          await redisClient.set(`customer_login_lock:${email}`, '1', 'EX', 900);
        }

        const ipCount = await redisClient.incr(ipCountKey);
        await redisClient.expire(ipCountKey, 900);
        if (ipCount >= 5) {
          await redisClient.set(`customer_login_lock_ip:${ip}`, '1', 'EX', 900);
        }
      } catch (redisErr) {
        console.warn('Login failure counter Redis error (non-fatal):', redisErr.message);
      }
    }

    if (customerResult.rows.length === 0) {
      await incrementFailures();
      // Non-blocking audit log
      pool.query(
        `INSERT INTO activities (user_id, activity_type, details, ip_address, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [null, 'login_failure', JSON.stringify({ email, reason: 'user_not_found' }), req.ip]
      ).catch(e => console.error('Audit log error:', e.message));
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const customer = customerResult.rows[0];

    // Compare password
    const passwordMatch = await bcrypt.compare(password, customer.password_hash || '');
    if (!passwordMatch) {
      await incrementFailures();
      // Non-blocking audit log
      pool.query(
        `INSERT INTO activities (user_id, activity_type, details, ip_address, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [customer.id, 'login_failure', JSON.stringify({ email, reason: 'wrong_password' }), req.ip]
      ).catch(e => console.error('Audit log error:', e.message));
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check is_verified BEFORE company status (Requirement 3.6)
    if (!customer.is_verified) {
      return res.status(403).json({ message: 'Please verify your email before logging in.' });
    }

    // Check company status — suspended OR inactive subscription
    if (customer.company_id) {
      const companyCheck = await pool.query(
        "SELECT status, subscription_status FROM companies WHERE id = $1",
        [customer.company_id]
      );
      const company = companyCheck.rows[0];
      if (company) {
        if (company.status === 'suspended') {
          return res.status(403).json({ message: 'Account Suspended/Disabled' });
        }
        if (company.subscription_status === 'expired' || company.subscription_status === 'cancelled') {
          return res.status(403).json({ message: 'Company subscription inactive' });
        }
      }
    }

    // Clear failure counters on success
    if (redisClient && redisClient.status === 'ready') {
      try {
        await redisClient.del(`customer_login_fail_count:${email}`);
        await redisClient.del(`customer_login_fail_count_ip:${ip}`);
        await redisClient.del(`customer_login_lock:${email}`);
        await redisClient.del(`customer_login_lock_ip:${ip}`);
      } catch (redisErr) {
        console.warn('Login counter clear Redis error (non-fatal):', redisErr.message);
      }
    }

    // Issue tokens
    const { accessToken } = await issueTokens(res, req, customer);

    // Non-blocking audit log
    auditLog(req, customer.id, 'customer_login_success', { email }, customer.company_id);

    return res.json({
      ok: true,
      user: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        company_id: customer.company_id,
      },
      token: accessToken,
    });
  } catch (err) {
    console.error('login error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /refresh ────────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies && req.cookies['customer_refresh_token'];

  if (!refreshToken) {
    return res.status(401).json({ message: 'No refresh token provided' });
  }

  try {
    // Look up token in dedicated customer_refresh_tokens table
    const tokenResult = await pool.query(
      `SELECT * FROM customer_refresh_tokens WHERE token = $1`,
      [refreshToken]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    const storedToken = tokenResult.rows[0];

    // Replay detection
    if (storedToken.revoked) {
      // Revoke entire token family
      pool.query(
        'UPDATE customer_refresh_tokens SET revoked = TRUE WHERE token_family = $1',
        [storedToken.token_family]
      ).catch(e => console.error('Token family revoke error:', e.message));

      auditLog(req, storedToken.customer_id, 'customer_token_replay', {}, null);
      return res.status(401).json({ message: 'Security alert: Token reuse detected.' });
    }

    // Verify JWT
    let payload;
    try {
      payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    // Fetch customer
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [payload.id]
    );

    if (customerResult.rows.length === 0) {
      return res.status(401).json({ message: 'Customer not found' });
    }

    const customer = customerResult.rows[0];

    // Revoke old token
    await pool.query(
      'UPDATE customer_refresh_tokens SET revoked = TRUE WHERE id = $1',
      [storedToken.id]
    );

    // Issue new tokens
    await issueTokens(res, req, customer);

    // Non-blocking audit log
    auditLog(req, customer.id, 'customer_token_refresh', {}, customer.company_id);

    return res.json({ ok: true });
  } catch (err) {
    console.error('refresh error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /logout ─────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const refreshToken = req.cookies && req.cookies['customer_refresh_token'];

  if (refreshToken) {
    pool.query(
      'UPDATE customer_refresh_tokens SET revoked = TRUE WHERE token = $1',
      [refreshToken]
    ).catch(e => console.error('Logout revoke error:', e.message));
  }

  // Clear cookies
  res.clearCookie('customer_access_token', { path: '/', sameSite: 'none', secure: true });
  res.clearCookie('customer_refresh_token', { path: '/', sameSite: 'none', secure: true });
  res.clearCookie('csrf_token', { path: '/', sameSite: 'none', secure: true });

  // Non-blocking audit log
  auditLog(req, null, 'customer_logout', {}, null);

  return res.json({ ok: true });
});

// ─── Google OAuth — register dedicated 'customer-google' strategy ─────────────
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use('customer-google', new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.BACKEND_URL || 'http://localhost:4000'}/api/customer/auth/google/callback`,
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails && profile.emails[0] && profile.emails[0].value;
        const googleId = profile.id;
        const name = profile.displayName || '';

        if (!email) {
          return done(new Error('No email from Google'), null);
        }

        // Email conflict check — block if email exists in users table (owner/employee)
        const userConflict = await pool.query(
          'SELECT id FROM users WHERE email = $1 LIMIT 1',
          [email]
        );
        if (userConflict.rows.length > 0) {
          // Signal the callback to redirect with EMAIL_ALREADY_USED error
          return done(null, { _emailConflict: true, email });
        }

        // Check if customer exists by google_id first, then by email
        const byGoogleId = await pool.query(
          'SELECT * FROM customers WHERE google_id = $1 LIMIT 1',
          [googleId]
        );

        if (byGoogleId.rows.length > 0) {
          // Existing Google customer — return as-is
          return done(null, byGoogleId.rows[0]);
        }

        // Check by email
        const byEmail = await pool.query(
          'SELECT * FROM customers WHERE email = $1 LIMIT 1',
          [email]
        );

        if (byEmail.rows.length === 0) {
          // Brand new customer — create with no company_id
          const newCustomer = await pool.query(
            `INSERT INTO customers (name, email, google_id, auth_provider, is_verified, company_id)
             VALUES ($1, $2, $3, 'google', TRUE, NULL)
             RETURNING *`,
            [name, email, googleId]
          );
          return done(null, { ...newCustomer.rows[0], _isNew: true });
        }

        const customer = byEmail.rows[0];

        // Email exists with manual auth — LINK Google to existing account
        // This is the fix: instead of blocking, we link the Google identity
        if (customer.auth_provider === 'manual') {
          const linked = await pool.query(
            `UPDATE customers
             SET google_id = $1, auth_provider = 'google'
             WHERE id = $2
             RETURNING *`,
            [googleId, customer.id]
          );
          return done(null, linked.rows[0]);
        }

        // Existing Google customer (matched by email, google_id was null/different) — update google_id
        const updated = await pool.query(
          `UPDATE customers SET google_id = $1 WHERE id = $2 RETURNING *`,
          [googleId, customer.id]
        );
        return done(null, updated.rows[0]);
      } catch (err) {
        return done(err, null);
      }
    }
  ));
}

// ─── GET /google ──────────────────────────────────────────────────────────────
router.get('/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ message: 'Google OAuth not configured' });
  }
  passport.authenticate('customer-google', {
    scope: ['profile', 'email'],
    session: false,
    state: JSON.stringify({ portal: 'customer' }),
  })(req, res, next);
});

// ─── GET /google/callback ─────────────────────────────────────────────────────
router.get('/google/callback', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.redirect(`${CUSTOMER_PORTAL_ORIGIN}/login?error=oauth_not_configured`);
  }

  passport.authenticate('customer-google', { session: false, failureRedirect: `${CUSTOMER_PORTAL_ORIGIN}/login?error=oauth_failed` }, async (err, customer) => {
    if (err || !customer) {
      console.error('Google callback error:', err && err.message);
      return res.redirect(`${CUSTOMER_PORTAL_ORIGIN}/login?error=oauth_failed`);
    }

    try {
      // Email already used in users table (owner/employee) — block
      if (customer._emailConflict) {
        auditLog(req, null, 'email_conflict_blocked', { email: customer.email, source: 'google_signup' }, null);
        return res.redirect(`${CUSTOMER_PORTAL_ORIGIN}/login?error=EMAIL_ALREADY_USED`);
      }

      // New customer — redirect to onboarding
      if (customer._isNew) {
        const tempToken = jwt.sign(
          { id: customer.id, purpose: 'onboarding', email: customer.email },
          JWT_SECRET,
          { expiresIn: '15m' }
        );
        return res.redirect(`${CUSTOMER_PORTAL_ORIGIN}/onboarding?token=${tempToken}`);
      }

      // Customer without company_id (Google-linked manual account or new Google account) — onboarding
      if (!customer.company_id) {
        const tempToken = jwt.sign(
          { id: customer.id, purpose: 'onboarding', email: customer.email },
          JWT_SECRET,
          { expiresIn: '15m' }
        );
        return res.redirect(`${CUSTOMER_PORTAL_ORIGIN}/onboarding?token=${tempToken}`);
      }

      // Existing customer with company_id — issue full JWT and redirect to dashboard
      await issueTokens(res, req, customer);
      auditLog(req, customer.id, 'customer_login_success', { email: customer.email, provider: 'google' }, customer.company_id);
      return res.redirect(`${CUSTOMER_PORTAL_ORIGIN}/dashboard`);
    } catch (callbackErr) {
      console.error('Google callback processing error:', callbackErr.message);
      return res.redirect(`${CUSTOMER_PORTAL_ORIGIN}/login?error=server_error`);
    }
  })(req, res, next);
});

// ─── POST /onboarding ─────────────────────────────────────────────────────────
router.post('/onboarding', [
  body('company_code').trim().notEmpty().withMessage('Company code is required'),
  body('phone').optional().trim(),
], async (req, res) => {
  // Read tempToken from Authorization header or request body
  let tempToken = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    tempToken = authHeader.split(' ')[1];
  } else if (req.body && req.body.tempToken) {
    tempToken = req.body.tempToken;
  }

  if (!tempToken) {
    return res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }

  let payload;
  try {
    payload = jwt.verify(tempToken, JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }

  if (payload.purpose !== 'onboarding') {
    return res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
  }

  const { company_code, phone } = req.body;

  try {
    // Validate company code
    const companyResult = await validateCompanyCode(company_code);
    if (!companyResult.valid) {
      return res.status(400).json({ message: 'Invalid company code' });
    }

    const companyId = companyResult.company.id;

    // Check company subscription status
    const companyCheck = await pool.query(
      'SELECT status, subscription_status FROM companies WHERE id = $1',
      [companyId]
    );
    const company = companyCheck.rows[0];
    if (company) {
      if (company.status === 'suspended') {
        return res.status(403).json({ message: 'Account Suspended/Disabled' });
      }
      if (company.subscription_status === 'expired' || company.subscription_status === 'cancelled') {
        return res.status(403).json({ message: 'Company subscription inactive' });
      }
    }

    // Update customer
    const updateResult = await pool.query(
      `UPDATE customers SET company_id = $1, phone = $2 WHERE id = $3 RETURNING *`,
      [companyId, phone || null, payload.id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const customer = updateResult.rows[0];

    // Issue full JWT cookies
    await issueTokens(res, req, customer);

    auditLog(req, customer.id, 'customer_onboarding_complete', { company_id: companyId }, companyId);

    return res.json({ ok: true });
  } catch (err) {
    console.error('onboarding error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /validate-company ────────────────────────────────────────────────────
router.get('/validate-company', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.json({ valid: false });
  }

  try {
    const result = await pool.query(
      'SELECT company_name FROM companies WHERE company_id = $1',
      [code]
    );

    if (result.rows.length === 0) {
      return res.json({ valid: false });
    }

    return res.json({ valid: true, companyName: result.rows[0].company_name });
  } catch (err) {
    console.error('validate-company error:', err.message);
    return res.json({ valid: false });
  }
});

module.exports = router;
