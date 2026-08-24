const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const logActivity = require("../helpers/logActivity");
const { authenticateToken } = require("../middleware/authMiddleware");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { Resend } = require("resend");
const { body, validationResult } = require("express-validator");
require("dotenv").config();
const crypto = require("crypto");
// ✅ Required at top-level — used in Google OAuth callback and all OTP/exchange routes
const { redisClient } = require("../utils/redis");
const { storage } = require("../middleware/als");

// ✅ RLS bypass — auth routes query users/companies by email BEFORE any company
// context is known (login lookup, OTP, Google OAuth). They explicitly opt-in to
// cross-tenant access rather than relying on an empty companyId.
router.use((req, res, next) => storage.run({ isWebRequest: true, bypassRls: true }, next));


// JWT secrets
const ACCESS_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || ACCESS_SECRET;

// Cookie Names & Lifetimes
const COOKIE_ACCESS_USER = "user_access_token";
const COOKIE_REFRESH_USER = "user_refresh_token";
const COOKIE_ACCESS_ADMIN = "superadmin_access_token";
const COOKIE_REFRESH_ADMIN = "superadmin_refresh_token";

const ACCESS_EXPIRY = "1h";
const REFRESH_EXPIRY = "30d";
const ACCESS_MAX_AGE = 1 * 60 * 60 * 1000; // 1 hour
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// ──────────────────────────────────────────────────────────────────────────────
// ✅ UNIFIED Google OAuth — single callback URL for staff AND customer portal
//
// Flow is selected via state.type (base64-encoded JSON in the OAuth state param):
//   state.type === 'customer'  → Customer Portal login/signup
//   state.type === 'staff'     → SmartERP staff (owner / employee) — default
//
// Google Cloud Console only needs ONE authorized redirect URI:
//   https://api.prozync.in/api/v1/auth/google/callback
// ──────────────────────────────────────────────────────────────────────────────
const backendDomain = process.env.NODE_ENV === 'production'
  ? 'https://api.prozync.in'
  : (process.env.BACKEND_URL || 'http://localhost:4000');
const googleCallback = process.env.GOOGLE_CALLBACK_URL
  || `${backendDomain}/api/v1/auth/google/callback`;

// ─── Unified Passport Strategy ────────────────────────────────────────────────
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: googleCallback,
      passReqToCallback: true,
    },
    async (req, _accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails && profile.emails[0] && profile.emails[0].value;
        const googleId = profile.id;
        const name = profile.displayName || '';

        if (!email) return done(new Error('No email from Google'), null);

        // Parse state (always base64-encoded JSON)
        let stateData = {};
        try {
          stateData = JSON.parse(Buffer.from(req.query.state || '', 'base64').toString());
        } catch (_) { /* ignore */ }

        // ── CUSTOMER FLOW ────────────────────────────────────────────────────
        if (stateData.type === 'customer') {
          // Block if email already belongs to a staff user
          const conflict = await pool.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
          if (conflict.rows.length > 0) {
            return done(null, { _isCustomer: true, _emailConflict: true, email });
          }

          // Lookup by google_id
          const byGid = await pool.query('SELECT * FROM customers WHERE google_id = $1 LIMIT 1', [googleId]);
          if (byGid.rows.length > 0) {
            return done(null, { ...byGid.rows[0], _isCustomer: true });
          }

          // Lookup by email
          const byEmail = await pool.query('SELECT * FROM customers WHERE email = $1 LIMIT 1', [email]);
          if (byEmail.rows.length === 0) {
            // Brand-new customer — create without company (needs onboarding)
            const newC = await pool.query(
              `INSERT INTO customers (name, email, google_id, auth_provider, is_verified, company_id)
               VALUES ($1, $2, $3, 'google', TRUE, NULL) RETURNING *`,
              [name, email, googleId]
            );
            return done(null, { ...newC.rows[0], _isCustomer: true, _isNew: true });
          }

          // Link Google to existing account
          const linked = await pool.query(
            `UPDATE customers SET google_id = $1, auth_provider = 'google' WHERE id = $2 RETURNING *`,
            [googleId, byEmail.rows[0].id]
          );
          return done(null, { ...linked.rows[0], _isCustomer: true });
        }

        // ── STAFF FLOW (owner / employee / super_admin) ───────────────────────
        let role = stateData.role || 'owner';
        const company_code = stateData.company_code || null;

        const userResult = await pool.query(
          'SELECT * FROM users WHERE google_id = $1 OR email = $2',
          [googleId, email]
        );

        let user;
        let companyId = null;
        let companyCode = null;

        if (userResult.rows.length > 0) {
          // Existing staff user — link Google ID if missing
          user = userResult.rows[0];
          if (!user.google_id) {
            await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, user.id]);
            user.google_id = googleId;
          }

          // Safeguard: If existing user has role='owner' but no company_id, auto-create company
          if (user.role === 'owner' && !user.company_id) {
            const { generateCompanyId } = require('../utils/companyIdGenerator');
            companyCode = await generateCompanyId();
            const companyName = `${name || user.name || 'Owner'}'s Company`;

            const companyResult = await pool.query(
              `INSERT INTO companies (company_id, company_name, plan_id, subscription_status,
                                      is_on_trial, trial_started_at, trial_ends_at,
                                      subscription_expires_at, is_first_login, created_at)
               VALUES ($1, $2, 3, 'trial', TRUE, NOW(), NOW() + INTERVAL '30 days',
                       NOW() + INTERVAL '30 days', TRUE, NOW())
               RETURNING id, company_id`,
              [companyCode, companyName]
            );
            companyId = companyResult.rows[0].id;

            await pool.query(
              'UPDATE users SET company_id = $1, company_code = $2 WHERE id = $3',
              [companyId, companyCode, user.id]
            );
            await pool.query('UPDATE companies SET owner_id = $1 WHERE id = $2', [user.id, companyId]);

            user.company_id = companyId;
            user.company_code = companyCode;
          }
        } else {
          // New staff user
          if (role === 'owner') {
            const { generateCompanyId } = require('../utils/companyIdGenerator');
            companyCode = await generateCompanyId();
            const companyName = `${name}'s Company`;

            const companyResult = await pool.query(
              `INSERT INTO companies (company_id, company_name, plan_id, subscription_status,
                                      is_on_trial, trial_started_at, trial_ends_at,
                                      subscription_expires_at, is_first_login, created_at)
               VALUES ($1, $2, 3, 'trial', TRUE, NOW(), NOW() + INTERVAL '30 days',
                       NOW() + INTERVAL '30 days', TRUE, NOW())
               RETURNING id, company_id`,
              [companyCode, companyName]
            );
            companyId = companyResult.rows[0].id;

            pool.query(
              `INSERT INTO subscription_events (company_id, event_type, old_plan_id, new_plan_id, metadata, created_at)
               VALUES ($1, 'trial_started', NULL, 3, $2, NOW())`,
              [companyId, JSON.stringify({ source: 'google_oauth', email })]
            ).catch(e => console.error('sub_event log error:', e.message));

            console.log(`✅ Created company ${companyCode} for Google owner ${email} (30-day Pro trial)`);
          }

          if (role === 'employee' && company_code) {
            const { validateCompanyCode } = require('../utils/companyIdGenerator');
            const validation = await validateCompanyCode(company_code);
            if (validation.valid) {
              companyId = validation.company.id;
              companyCode = validation.company.company_id;
              console.log(`✅ Google employee ${email} validated for company ${companyCode}`);
            } else {
              return done(new Error('Invalid company code'), null);
            }
          }

          const insertResult = await pool.query(
            `INSERT INTO users (name, email, google_id, role, company_id, company_code, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
            [name, email, googleId, role, companyId, companyCode]
          );
          user = insertResult.rows[0];

          if (role === 'owner' && companyId) {
            await pool.query('UPDATE companies SET owner_id = $1 WHERE id = $2', [user.id, companyId]);
          }
        }

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

// ─── Initiate Google Login ────────────────────────────────────────────────────
// Query params:
//   ?type=customer               → Customer Portal
//   ?role=owner|employee         → Staff (default: owner)
//   ?company_code=XXX            → Employee join flow
router.get('/google', (req, res, next) => {
  const FRONTEND = process.env.FRONTEND_ORIGIN || 'https://www.prozync.in';
  
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.warn("⚠️ Google OAuth credentials not configured on backend");
    return res.redirect(`${FRONTEND}/auth/login?error=oauth_not_configured`);
  }

  const type = req.query.type === 'customer' ? 'customer' : 'staff';
  const statePayload = type === 'customer'
    ? { type: 'customer' }
    : { type: 'staff', role: req.query.role || 'owner', company_code: req.query.company_code || null };

  const state = Buffer.from(JSON.stringify(statePayload)).toString('base64');
  
  try {
    passport.authenticate('google', { scope: ['profile', 'email'], session: false, state })(req, res, (err) => {
      if (err) {
        console.error('Google OAuth init error:', err.message);
        return res.redirect(`${FRONTEND}/auth/login?error=oauth_failed`);
      }
      next();
    });
  } catch (err) {
    console.error('Google OAuth route error:', err.message);
    return res.redirect(`${FRONTEND}/auth/login?error=oauth_failed`);
  }
});

// ─── Google Callback (unified) ────────────────────────────────────────────────
router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, async (err, user) => {
    // Parse state so we know which portal to redirect failures to
    let stateData = {};
    try { stateData = JSON.parse(Buffer.from(req.query.state || '', 'base64').toString()); } catch (_) {}
    const CUSTOMER_PORTAL = process.env.CUSTOMER_PORTAL_ORIGIN || 'http://localhost:3001';
    const FRONTEND = process.env.FRONTEND_ORIGIN || 'https://www.prozync.in';

    if (err || !user) {
      console.error('Google OAuth error:', err && err.message);
      return res.redirect(stateData.type === 'customer'
        ? `${CUSTOMER_PORTAL}/login?error=oauth_failed`
        : `${FRONTEND}/login?error=oauth_failed`);
    }

    try {
      // ── Customer callback ──────────────────────────────────────────────────
      if (user._isCustomer) {
        if (user._emailConflict) {
          return res.redirect(`${CUSTOMER_PORTAL}/login?error=EMAIL_ALREADY_USED`);
        }

        if (user._isNew || !user.company_id) {
          const tempToken = jwt.sign(
            { id: user.id, purpose: 'onboarding', email: user.email },
            ACCESS_SECRET,
            { expiresIn: '15m' }
          );
          return res.redirect(`${CUSTOMER_PORTAL}/onboarding?token=${tempToken}`);
        }

        // Existing customer with company — issue JWT cookies and redirect
        const custAccess = jwt.sign(
          { id: user.id, role: 'customer', companyId: user.company_id, email: user.email },
          ACCESS_SECRET, { expiresIn: '1h' }
        );
        const custRefresh = jwt.sign({ id: user.id }, REFRESH_SECRET, { expiresIn: '30d' });

        await pool.query(
          `INSERT INTO customer_refresh_tokens
             (customer_id, token, token_family, expires_at, user_agent, ip_address)
           VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', $4, $5)`,
          [user.id, custRefresh, crypto.randomUUID(), req.get('user-agent') || null, req.ip || null]
        );

        const cOpts = { httpOnly: true, sameSite: 'none', secure: true, path: '/' };
        res.cookie('customer_access_token',  custAccess,  { ...cOpts, maxAge: ACCESS_MAX_AGE });
        res.cookie('customer_refresh_token', custRefresh, { ...cOpts, maxAge: REFRESH_MAX_AGE });
        res.cookie('csrf_token', crypto.randomBytes(32).toString('hex'),
          { httpOnly: false, sameSite: 'none', secure: true, path: '/', maxAge: ACCESS_MAX_AGE });

        return res.redirect(`${CUSTOMER_PORTAL}/dashboard`);
      }

      // ── Staff callback ─────────────────────────────────────────────────────
      if (user.role !== 'super_admin' && user.company_id) {
        const companyRes = await pool.query('SELECT status FROM companies WHERE id = $1', [user.company_id]);
        if (companyRes.rows.length > 0 && companyRes.rows[0].status === 'suspended') {
          console.warn(`🛑 Google login blocked for suspended company user: ${user.email}`);
          return res.redirect(`${FRONTEND}/suspended`);
        }
      }

      await logActivity(user.id, 'login_google', req);

      const staffAccess = jwt.sign(
        { id: user.id, userId: user.id, role: user.role, email: user.email, companyId: user.company_id },
        ACCESS_SECRET, { expiresIn: ACCESS_EXPIRY }
      );
      const staffRefresh = jwt.sign({ id: user.id, userId: user.id }, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRY });

      const tokenFamily = crypto.randomUUID();
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token, token_family, expires_at, created_at, user_agent, ip_address)
         VALUES ($1::uuid, $2, $3::uuid, NOW() + INTERVAL '30 days', NOW(), $4, $5)`,
        [user.id, staffRefresh, tokenFamily, req.headers['user-agent'], req.ip]
      );

      const isSuperAdmin = user.role === 'super_admin';
      const sOpts = { httpOnly: true, sameSite: 'none', secure: true, path: '/' };
      res.cookie(isSuperAdmin ? COOKIE_ACCESS_ADMIN  : COOKIE_ACCESS_USER,  staffAccess,  { ...sOpts, maxAge: ACCESS_MAX_AGE });
      res.cookie(isSuperAdmin ? COOKIE_REFRESH_ADMIN : COOKIE_REFRESH_USER, staffRefresh, { ...sOpts, maxAge: REFRESH_MAX_AGE });

      // Secure one-time code exchange (tokens never in URL)
      const oauthCode = crypto.randomUUID();
      const oauthPayload = JSON.stringify({
        accessToken: staffAccess, refreshToken: staffRefresh,
        user: { id: user.id, name: user.name, email: user.email, role: user.role,
                company_id: user.company_id, companyId: user.company_id },
      });

      if (redisClient && redisClient.status === 'ready') {
        await redisClient.set(`oauth_code:${oauthCode}`, oauthPayload, 'EX', 60);
        return res.redirect(`${FRONTEND}/auth/callback?code=${oauthCode}`);
      }

      // Redis unavailable — fallback (no tokens in URL, just user info)
      console.warn('⚠️ Redis unavailable for OAuth code exchange, using fallback');
      return res.redirect(
        `${FRONTEND}/auth/callback?code=fallback&user=${encodeURIComponent(
          JSON.stringify({ id: user.id, name: user.name, email: user.email,
                          role: user.role, company_id: user.company_id, companyId: user.company_id })
        )}`
      );
    } catch (err) {
      console.error('Google Auth Error:', err);
      return res.redirect(`${FRONTEND}/login?error=auth_failed`);
    }
  })(req, res, next);
});



// ---------------------------------------------
// ✅ POST /api/auth/exchange-code
// Exchanges a short-lived OAuth one-time code for session tokens
// The code is stored in Redis for 60s — single use
// ---------------------------------------------
router.post("/exchange-code", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: "Code is required" });

  try {
    if (!redisClient || redisClient.status !== "ready") {
      return res.status(503).json({ message: "Auth service temporarily unavailable" });
    }

    const raw = await redisClient.get(`oauth_code:${code}`);
    if (!raw) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    // Consume the code (one-time use)
    await redisClient.del(`oauth_code:${code}`);

    const { accessToken, refreshToken, user } = JSON.parse(raw);

    const isSuperAdmin = user.role === "super_admin";
    const accessCookieName = isSuperAdmin ? COOKIE_ACCESS_ADMIN : COOKIE_ACCESS_USER;
    const refreshCookieName = isSuperAdmin ? COOKIE_REFRESH_ADMIN : COOKIE_REFRESH_USER;

    const cookieOpts = {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    };

    res.cookie(accessCookieName, accessToken, { ...cookieOpts, maxAge: ACCESS_MAX_AGE });
    res.cookie(refreshCookieName, refreshToken, { ...cookieOpts, maxAge: REFRESH_MAX_AGE });

    // Also return tokens in body so the frontend can store them in sessionStorage
    // (cookies alone fail cross-origin in modern browsers blocking 3rd-party cookies)
    res.json({ ok: true, user, accessToken, refreshToken });
  } catch (err) {
    console.error("exchange-code error:", err.message);
    res.status(500).json({ message: "Authentication failed. Please try again." });
  }
});



// ---------------------------------------------
// ✅ Send OTP for email verification (signup only)
// ---------------------------------------------
router.post("/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });

  // 🛡️ OTP Rate Limiting (5 requests per 10 minutes)
  const otpLimitKey = `otp_attempts:${email}`;
  if (redisClient && redisClient.status === 'ready') {
    try {
      const attempts = await redisClient.get(otpLimitKey);
      if (attempts && parseInt(attempts, 10) >= 5) {
        const ttl = await redisClient.ttl(otpLimitKey);
        const minutesLeft = Math.ceil(ttl / 60);
        console.warn(`🛡️  OTP Blocked for ${email}. Too many requests.`);
        return res.status(429).json({
          message: `You have reached the OTP request limit. Please try again after ${minutesLeft} minutes.`,
          retryAfter: ttl
        });
      }
    } catch (err) {
      console.warn("⚠️ Rate limit check failed (Redis):", err.message);
    }
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set");
    return res.status(500).json({ message: "Email service not configured. Contact support." });
  }

  try {
    // Increment OTP attempts in Redis
    if (redisClient && redisClient.status === 'ready') {
      try {
        const multi = redisClient.multi();
        multi.incr(otpLimitKey);
        multi.expire(otpLimitKey, 600); // 10 minutes TTL
        await multi.exec();
      } catch (err) {
        console.warn("⚠️ Redis incr failed:", err.message);
      }
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Old OTP cleanup and storage (Table is now ensured on server startup)
    await pool.query("DELETE FROM email_otps WHERE email = $1", [email]);

    // Hash OTP before storage — plaintext OTPs in DB are a breach risk
    const otpHash = crypto.createHash("sha256").update(otp + email).digest("hex");
    await pool.query(
      "INSERT INTO email_otps (email, otp_code, expires_at) VALUES ($1, $2, $3)",
      [email, otpHash, expiresAt]
    );

    // Send email via Resend with a 10s timeout safety
    const resend = new Resend(process.env.RESEND_API_KEY);

    // We race the email send with a timeout to avoid hanging the UI
    const sendPromise = resend.emails.send({
      from: "SmartERP <noreply@prozync.in>",
      to: email,
      subject: "Your SmartERP Verification Code",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f8fafc; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="background: #4F46E5; display: inline-block; padding: 12px 20px; border-radius: 8px;">
              <span style="color: white; font-size: 20px; font-weight: bold;">SmartERP</span>
            </div>
          </div>
          <h2 style="color: #1e293b; text-align: center; margin-bottom: 8px;">Email Verification</h2>
          <p style="color: #64748b; text-align: center; margin-bottom: 32px;">Use the code below to verify your email and create your account.</p>
          <div style="background: white; border: 2px solid #e2e8f0; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
            <div style="font-size: 42px; font-weight: bold; letter-spacing: 10px; color: #4F46E5; font-family: monospace;">${otp}</div>
          </div>
          <p style="color: #94a3b8; text-align: center; font-size: 13px;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
          <p style="color: #cbd5e1; text-align: center; font-size: 12px; margin-top: 24px;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Email service timeout')), 12000));

    const sendResult = await Promise.race([sendPromise, timeoutPromise]);


    if (sendResult.error) {
      console.error("Resend error:", sendResult.error);
      return res.status(500).json({ message: "Failed to send OTP: " + sendResult.error.message });
    }

    console.log(`✅ OTP sent to ${email}`, sendResult.data?.id);
    res.json({ ok: true, message: "OTP sent to your email" });
  } catch (err) {
    console.error("Send OTP error:", err.message);
    res.status(500).json({ message: "Failed to send OTP. Please try again." });
  }
});


// ---------------------------------------------
// ✅ Verify OTP (rate-limited + hash-compared)
// ---------------------------------------------
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  keyGenerator: (req) => {
    const email = req.body?.email;
    if (email) return email.toLowerCase();
    return ipKeyGenerator(req);
  },
  message: { message: "Too many OTP attempts. Please request a new code." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/verify-otp", otpVerifyLimiter, async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: "Email and OTP are required" });

  // Per-email Redis attempt counter (belt-and-suspenders alongside the IP limiter)
  if (redisClient && redisClient.status === "ready") {
    try {
      const attemptKey = `otp_verify_attempts:${email.toLowerCase()}`;
      const attempts = await redisClient.incr(attemptKey);
      if (attempts === 1) await redisClient.expire(attemptKey, 900); // 15 min TTL
      if (attempts > 5) {
        return res.status(429).json({ message: "Too many OTP attempts. Please request a new code." });
      }
    } catch (redisErr) {
      console.warn("⚠️ OTP attempt counter Redis error:", redisErr.message);
    }
  }

  try {
    // Compute hash of submitted OTP (same algorithm used during storage)
    const submittedHash = crypto.createHash("sha256").update(otp.toString().trim() + email.toLowerCase()).digest("hex");

    const result = await pool.query(
      "SELECT * FROM email_otps WHERE email = $1 AND otp_code = $2 AND used = FALSE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
      [email.toLowerCase(), submittedHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired OTP. Please request a new one." });
    }

    // Mark OTP as used — single-use enforcement
    await pool.query("UPDATE email_otps SET used = TRUE WHERE id = $1", [result.rows[0].id]);

    // Clear the attempt counter on success
    if (redisClient && redisClient.status === "ready") {
      await redisClient.del(`otp_verify_attempts:${email.toLowerCase()}`).catch(() => {});
    }

    res.json({ ok: true, verified: true, message: "Email verified successfully" });
  } catch (err) {
    console.error("Verify OTP error:", err.message);
    res.status(500).json({ message: "Verification failed. Please try again." });
  }
});

// ---------------------------------------------
// ✅ Signup (Register New Users)
// ---------------------------------------------
router.post("/signup", [
  body("name").trim().notEmpty().withMessage("Name is required").escape(),
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("password")
    .isLength({ min: 10 }).withMessage("Password must be at least 10 characters long")
    .matches(/[A-Z]/).withMessage("Password must contain at least one uppercase letter")
    .matches(/[0-9]/).withMessage("Password must contain at least one number")
    .matches(/[^A-Za-z0-9]/).withMessage("Password must contain at least one special character"),
  body("role").optional().isIn(["owner", "employee"]).withMessage("Invalid role"),
  body("phone").optional({ checkFalsy: true }).isMobilePhone().withMessage("Invalid phone number").escape(),
  body("position").optional({ checkFalsy: true }).trim().escape(),
  body("department").optional({ checkFalsy: true }).trim().escape(),
  body("company_code").optional({ checkFalsy: true }).trim().escape(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: "Validation failed", errors: errors.array() });
  }

  const { name, email, password, role = "owner", phone, position, department, company_code } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Transactional OTP Verification
    const otpCheck = await client.query(
      "SELECT id FROM email_otps WHERE email = $1 AND used = TRUE AND created_at > NOW() - INTERVAL '15 minutes' ORDER BY created_at DESC LIMIT 1",
      [email]
    );

    if (otpCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Email not verified. Please verify your email with OTP before signing up." });
    }

    // 2. Duplicate Check
    const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    let companyId = null;
    let companyCode = null;
    let companyName = null;

    // ─── OWNER FLOW ────────────────────────────────────────────────────────
    if (role.toLowerCase() === 'owner') {
      const { generateCompanyId } = require('../utils/companyIdGenerator');
      companyCode = await generateCompanyId();
      companyName = `${name}'s Company`;

      const companyResult = await client.query(
        `INSERT INTO companies (company_id, company_name, plan_id, subscription_status, is_on_trial, trial_started_at, trial_ends_at, subscription_expires_at, is_first_login, created_at)
         VALUES ($1, $2, 3, 'trial', TRUE, NOW(), NOW() + INTERVAL '30 days', NOW() + INTERVAL '30 days', TRUE, NOW())
         RETURNING id`,
        [companyCode, companyName]
      );
      companyId = companyResult.rows[0].id;

      await client.query(
        `INSERT INTO subscriptions (company_id, plan_id, start_date, status) VALUES ($1, 3, NOW(), 'trial')`,
        [companyId]
      );

      await client.query(
        `INSERT INTO subscription_events (company_id, event_type, new_plan_id, metadata, created_at)
         VALUES ($1, 'trial_started', 3, $2, NOW())`,
        [companyId, JSON.stringify({ source: 'email_signup', email })]
      );
    }

    // ─── EMPLOYEE FLOW ──────────────────────────────────────────────────────
    else if (role.toLowerCase() === 'employee') {
      if (!company_code) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Company code is required" });
      }

      const { validateCompanyCode } = require('../utils/companyIdGenerator');
      const validation = await validateCompanyCode(company_code);

      if (!validation.valid) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid company code" });
      }

      companyId = validation.company.id;
      companyCode = validation.company.company_id;
      companyName = validation.company.company_name;

      // Atomic Employee Limit Check
      const planCheck = await client.query(
        `SELECT p.employee_limit, (SELECT COUNT(*) FROM users WHERE company_id = $1 AND role = 'employee') as current_count
         FROM companies c JOIN plans p ON c.plan_id = p.id WHERE c.id = $1`,
        [companyId]
      );

      if (planCheck.rows.length > 0) {
        const { employee_limit, current_count } = planCheck.rows[0];
        if (employee_limit !== null && parseInt(current_count) >= employee_limit) {
          await client.query("ROLLBACK");
          return res.status(403).json({ message: "Employee limit reached for this company's plan." });
        }
      }
    }

    // 3. Create User
    const userInsert = await client.query(
      `INSERT INTO users (name, email, password_hash, role, phone, position, department, company_id, company_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING id, name, email, role, phone, position, department, company_id, company_code, created_at`,
      [name, email, hashedPassword, role.toLowerCase(), phone || null, position || null, department || null, companyId, companyCode]
    );
    const user = userInsert.rows[0];

    // 4. Update Company Owner if needed
    if (role.toLowerCase() === 'owner') {
      await client.query('UPDATE companies SET owner_id = $1 WHERE id = $2', [user.id, companyId]);
    }

    await client.query("COMMIT");

    // ─── POST-TRANSACTION (Offloaded to Redis Queues) ──────────────────
    const { enqueueNotification, enqueueAudit } = require('../utils/queue');

    // Fire and forget enqueuing
    enqueueAudit({ userId: user.id, action: 'signup', reqInfo: { ip: req.ip, agent: req.get('user-agent') } })
      .catch(e => console.error('Queue Audit Error:', e.message));

    if (role.toLowerCase() === 'employee') {
      enqueueNotification({
        user_id: user.id,
        company_id: companyId,
        type: 'employee_registration',
        title: 'New Employee Registered',
        message: `${name || email} joined your company`,
        priority: 'medium',
        data: { employee_id: user.id, employee_email: email }
      }).catch(e => console.error('Queue Notification Error:', e.message));
    }

    res.status(201).json({ ok: true, user: { ...user, company_name: companyName }, company_code: companyCode });

  } catch (err) {
    if (client) await client.query("ROLLBACK");
    console.error("Signup Transaction Error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ message: "Server error during account creation" });
    }
  } finally {
    if (client) client.release();
  }
});

// ---------------------------------------------
// ✅ Check if email is already registered (used before OTP send to give early feedback)
// ---------------------------------------------
router.post("/check-email", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });
  try {
    const result = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    res.json({ exists: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// ---------------------------------------------
// ✅ Login Route
// ---------------------------------------------
router.post("/login", async (req, res) => {
  const rawIdentifier = (req.body.email || req.body.username || '').trim();
  const password = req.body.password;

  if (!rawIdentifier || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  const identifier = rawIdentifier.toLowerCase();

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(email) = $1 OR LOWER(name) = $1",
      [identifier]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const user = result.rows[0];

    // Check if company is suspended (Only if not super_admin)
    if (user.role !== 'super_admin' && user.company_id) {
      const companyRes = await pool.query("SELECT status FROM companies WHERE id = $1", [user.company_id]);
      if (companyRes.rows.length > 0 && companyRes.rows[0].status === 'suspended') {
        console.warn(`🛑 Login blocked for suspended company user: ${email}`);
        return res.status(403).json({
          message: "Account Suspended/Disabled",
          error: "company_suspended",
          details: "Your account is suspended/disabled because of some unusual activities found in your account. Please contact our customer care to reactivate account. Customer care email: prozyncinnovations@gmail.com"
        });
      }
    }

    // Check if user has a password (google-only users won't)
    if (!user.password_hash) {
      return res.status(401).json({ message: "Please log in with Google" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    await logActivity(user.id, "login", req);

    // Generate Tokens with new lifetimes
    const accessToken = jwt.sign(
      { id: user.id, userId: user.id, role: user.role, email: user.email, companyId: user.company_id },
      ACCESS_SECRET,
      { expiresIn: ACCESS_EXPIRY }
    );
    const refreshToken = jwt.sign(
      { id: user.id, userId: user.id },
      REFRESH_SECRET,
      { expiresIn: REFRESH_EXPIRY }
    );

    // Revoke all previous refresh tokens for this user on new login
    // Prevents stolen old tokens from remaining valid for 30 days
    await pool.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1::uuid AND revoked = FALSE`,
      [user.id]
    );

    // Save Refresh Token to DB
    const tokenFamily = crypto.randomUUID();
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, token_family, expires_at, created_at, user_agent, ip_address)
       VALUES ($1::uuid, $2, $3::uuid, NOW() + INTERVAL '30 days', NOW(), $4, $5)`,
      [user.id, refreshToken, tokenFamily, req.headers["user-agent"], req.ip]
    );

    // Set Cookies based on role
    const isSuperAdmin = user.role === 'super_admin';
    const accessCookieName = isSuperAdmin ? COOKIE_ACCESS_ADMIN : COOKIE_ACCESS_USER;
    const refreshCookieName = isSuperAdmin ? COOKIE_REFRESH_ADMIN : COOKIE_REFRESH_USER;

    const cookieOpts = {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    };

    res.cookie(accessCookieName, accessToken, { ...cookieOpts, maxAge: ACCESS_MAX_AGE });
    res.cookie(refreshCookieName, refreshToken, { ...cookieOpts, maxAge: REFRESH_MAX_AGE });

    console.log(`✅ Login successful for ${user.role}: ${user.email}`);

    delete user.password_hash;

    res.json({
      ok: true,
      user,
      accessToken,
      refreshToken,
      isSuperAdmin
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ message: "Server error during login" });
  }
});

// ---------------------------------------------
// ✅ Refresh Token Route (Secure Rotation)
// ---------------------------------------------
router.post("/refresh", async (req, res) => {
  // Try dual-context cookies first, then generic fallback, then body
  const token = req.cookies?.[COOKIE_REFRESH_ADMIN] ||
    req.cookies?.[COOKIE_REFRESH_USER] ||
    req.cookies?.refresh_token ||
    req.body?.refreshToken;

  if (!token) {
    console.warn("⚠️ Refresh attempt failed: No refresh token provided");
    return res.status(401).json({ message: "No refresh token provided" });
  }

  try {
    // 1. Check DB for the token
    const tokenResult = await pool.query("SELECT * FROM refresh_tokens WHERE token = $1", [token]);

    if (tokenResult.rows.length === 0) {
      console.warn("⚠️ Refresh attempt failed: Token not found in database.");
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    const refreshTokenData = tokenResult.rows[0];

    // 2. REPLAY & TAB-SWITCH CONCURRENCY PROTECTION
    if (refreshTokenData.revoked) {
      if (refreshTokenData.token_family) {
        const activeFamilyRes = await pool.query(
          `SELECT token FROM refresh_tokens 
           WHERE token_family = $1::uuid AND revoked = FALSE AND expires_at > NOW()
           ORDER BY created_at DESC LIMIT 1`,
          [refreshTokenData.token_family]
        );

        if (activeFamilyRes.rows.length > 0) {
          try {
            const payload = jwt.verify(activeFamilyRes.rows[0].token, REFRESH_SECRET);
            const userId = payload.userId || payload.id;
            const userRes = await pool.query("SELECT id, role, email, company_id FROM users WHERE id = $1", [userId]);
            if (userRes.rows.length > 0) {
              const user = userRes.rows[0];
              const newAccessToken = jwt.sign(
                { id: user.id, userId: user.id, role: user.role, email: user.email, companyId: user.company_id },
                ACCESS_SECRET,
                { expiresIn: ACCESS_EXPIRY }
              );
              return res.json({
                ok: true,
                accessToken: newAccessToken,
                refreshToken: activeFamilyRes.rows[0].token,
                isSuperAdmin: user.role === 'super_admin'
              });
            }
          } catch (_) { /* fallback */ }
        }
      }

      console.warn(`⚠️ Token ${token.substring(0, 10)}... was previously revoked.`);
      return res.status(401).json({ message: "Refresh token superseded. Please log in again." });
    }

    // 3. Verify JWT (Synchronous check inside try-catch)
    let payload;
    try {
      payload = jwt.verify(token, REFRESH_SECRET);
    } catch (jwtErr) {
      console.warn(`⚠️ Refresh attempt failed: JWT verification error: ${jwtErr.message}`);
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }

    const userId = payload.userId || payload.id;

    // 4. Fetch User Data
    const userRes = await pool.query("SELECT id, role, email, company_id FROM users WHERE id = $1", [userId]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ message: "User not found" });
    }
    const user = userRes.rows[0];

    // 5. Check Suspension
    if (user.role !== 'super_admin' && user.company_id) {
      const compRes = await pool.query("SELECT status FROM companies WHERE id = $1", [user.company_id]);
      if (compRes.rows.length > 0 && compRes.rows[0].status === 'suspended') {
        return res.status(403).json({
          message: "Account Suspended/Disabled",
          error: "company_suspended",
          details: "Your account is suspended/disabled. Please contact prozyncinnovations@gmail.com"
        });
      }
    }

    // 6. ROTATION: Mark old token as revoked
    await pool.query("UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1", [refreshTokenData.id]);

    // 7. Issue NEW tokens
    const newAccessToken = jwt.sign(
      { id: user.id, userId: user.id, role: user.role, email: user.email, companyId: user.company_id },
      ACCESS_SECRET,
      { expiresIn: ACCESS_EXPIRY }
    );
    const newRefreshToken = jwt.sign({ id: user.id, userId: user.id }, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRY });

    const familyToUse = refreshTokenData.token_family || crypto.randomUUID();

    // Save new token to DB
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, token_family, expires_at, created_at, user_agent, ip_address)
       VALUES ($1::uuid, $2, $3::uuid, NOW() + INTERVAL '30 days', NOW(), $4, $5)`,
      [user.id, newRefreshToken, familyToUse, req.headers["user-agent"] || null, req.ip || null]
    );

    // 8. Set Cookies based on role
    const isSuperAdmin = user.role === 'super_admin';
    const accessCookieName = isSuperAdmin ? COOKIE_ACCESS_ADMIN : COOKIE_ACCESS_USER;
    const refreshCookieName = isSuperAdmin ? COOKIE_REFRESH_ADMIN : COOKIE_REFRESH_USER;

    const cookieOpts = {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    };

    res.cookie(accessCookieName, newAccessToken, { ...cookieOpts, maxAge: ACCESS_MAX_AGE });
    res.cookie(refreshCookieName, newRefreshToken, { ...cookieOpts, maxAge: REFRESH_MAX_AGE });

    console.log(`✅ Token rotated for ${user.email} (Family: ${familyToUse})`);

    return res.json({
      ok: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      isSuperAdmin
    });
  } catch (err) {
    console.error("❌ Refresh route error:", err.message || err);
    return res.status(401).json({
      message: "Server error during refresh",
      error: "Unauthorized"
    });
  }
});

// ---------------------------------------------
// ✅ Get Current User Profile (Fresh from DB)
// ---------------------------------------------
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const result = await pool.query(
      `SELECT id, name, email, role, company_id, company_code 
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = result.rows[0];
    res.json(user);
  } catch (err) {
    console.error("GET /me error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------------------------------------------
// ✅ Logout Route
// ---------------------------------------------
router.post("/logout", async (req, res) => {
  try {
    // Accept refresh token from role-specific cookies OR generic fallback OR body
    const token =
      req.cookies?.[COOKIE_REFRESH_ADMIN] ||
      req.cookies?.[COOKIE_REFRESH_USER] ||
      req.cookies?.refresh_token ||
      req.body?.refreshToken;

    if (token) {
      const rt = await pool.query("SELECT * FROM refresh_tokens WHERE token = $1", [token]);
      if (rt.rows.length) {
        const userId = rt.rows[0].user_id;
        await logActivity(userId, "logout", req);
      }
      await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [token]);
    }

    // ✅ Clear ALL possible cookie names (role-specific + legacy generic)
    const cookieOpts = { sameSite: "none", secure: true, path: "/" };
    res.clearCookie(COOKIE_ACCESS_USER, cookieOpts);
    res.clearCookie(COOKIE_REFRESH_USER, cookieOpts);
    res.clearCookie(COOKIE_ACCESS_ADMIN, cookieOpts);
    res.clearCookie(COOKIE_REFRESH_ADMIN, cookieOpts);
    res.clearCookie("access_token", cookieOpts);
    res.clearCookie("refresh_token", cookieOpts);

    res.json({ ok: true });
  } catch (err) {
    console.error("Logout error:", err.message);
    res.status(500).json({ message: "Server error during logout" });
  }
});

// ---------------------------------------------
// ✅ Validate Company Code
// ---------------------------------------------
router.post("/validate-company", async (req, res) => {
  const { company_code } = req.body;

  if (!company_code) {
    return res.status(400).json({ message: "Company code is required" });
  }

  try {
    const { validateCompanyCode } = require('../utils/companyIdGenerator');
    const validation = await validateCompanyCode(company_code);

    if (validation.valid) {
      return res.json({
        valid: true,
        company_name: validation.company.company_name,
        company_id: validation.company.company_id
      });
    }

    return res.json({ valid: false });
  } catch (err) {
    console.error("Company validation error:", err.message);
    res.status(500).json({ message: "Server error during validation" });
  }
});

// ---------------------------------------------
// ✅ Get Company Settings (Authenticated)
// ---------------------------------------------
router.get("/company/settings", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId;

    if (!companyId) {
      return res.status(404).json({ message: "No company associated with this account" });
    }

    const result = await pool.query(
      'SELECT id, company_id, company_name, created_at FROM companies WHERE id = $1',
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Company not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Get company settings error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------------------------------------------
// ✅ Generate Invite Link (Owner Only)
// ---------------------------------------------
router.post("/company/generate-invite", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ message: "Only owners can generate invite links" });
    }

    const companyId = req.user.companyId;

    if (!companyId) {
      return res.status(404).json({ message: "No company associated with this account" });
    }

    const result = await pool.query(
      'SELECT company_id, company_name FROM companies WHERE id = $1',
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Company not found" });
    }

    const company = result.rows[0];
    const frontendUrl = process.env.FRONTEND_ORIGIN || "https://www.prozync.in";
    const inviteLink = `${frontendUrl}/join?company=${company.company_id}`;

    res.json({
      invite_link: inviteLink,
      company_id: company.company_id,
      company_name: company.company_name
    });
  } catch (err) {
    console.error("Generate invite link error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------------------------------------------
// ✅ Set Cookie Route (used after Google OAuth callback)
// Frontend calls this with tokens from URL to get HttpOnly cookies set on the backend domain
// ---------------------------------------------
router.post("/set-cookie", async (req, res) => {
  const { accessToken, refreshToken } = req.body;
  if (!accessToken || !refreshToken) {
    return res.status(400).json({ message: "Tokens are required" });
  }

  try {
    // Validate their structure before setting (lightweight check)
    jwt.verify(accessToken, ACCESS_SECRET);

    const cookieOpts = {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    };

    res.cookie("access_token", accessToken, { ...cookieOpts, maxAge: 24 * 60 * 60 * 1000 });
    res.cookie("refresh_token", refreshToken, { ...cookieOpts, maxAge: 7 * 24 * 60 * 60 * 1000 });

    console.log("✅ Cookies set via /set-cookie exchange");
    res.json({ ok: true });
  } catch (err) {
    console.error("Invalid token in /set-cookie:", err.message);
    return res.status(401).json({ message: "Invalid token" });
  }
});

// ---------------------------------------------
// ✅ Test Route
// ---------------------------------------------
router.get("/", (req, res) => {
  res.json({ message: "Auth API working fine ✅" });
});

// ─── PATCH /api/auth/update-push-token ───────────────────────────────────────
// Update user's push notification token for mobile/web push
router.patch('/update-push-token', authenticateToken, async (req, res) => {
  updatePushToken(req, res);
});

router.post('/update-push-token', authenticateToken, async (req, res) => {
  updatePushToken(req, res);
});

async function updatePushToken(req, res) {
  try {
    const { pushToken } = req.body;
    const userId = req.user.userId || req.user.id;

    console.log(`\n📲 --- APK PUSH TOKEN RECEIVED ---`);
    console.log(`👤 User ID: ${userId}`);
    console.log(`🔑 pushToken: ${pushToken ? pushToken.substring(0, 20) + '...' : 'undefined'}`);
    console.log(`----------------------------------\n`);

    if (!pushToken) {
      return res.status(400).json({ message: 'Push token is required' });
    }

    await pool.query(
      'UPDATE users SET push_token = $1 WHERE id = $2',
      [pushToken, userId]
    );

    // ── Multi-device Sync ───────────────────────────────────────────────────
    // Also store in user_devices so the new notification system picks it up.
    // We assume 'mobile_android' for this legacy endpoint.
    try {
      await pool.query(
        `INSERT INTO user_devices (user_id, fcm_token, device_type, last_seen)
         VALUES ($1, $2, 'mobile_android', NOW())
         ON CONFLICT (fcm_token) 
         DO UPDATE SET last_seen = NOW(), device_type = 'mobile_android', user_id = EXCLUDED.user_id`,
        [userId, pushToken]
      );
      console.log(`✅ Push token synced to user_devices for user ${userId}`);
    } catch (syncErr) {
      console.error('⚠️ Failed to sync push token to user_devices:', syncErr.message);
      // We don't fail the request if sync fails, as the legacy column was updated.
    }

    res.json({ message: 'Push token updated successfully' });
  } catch (err) {
    console.error('❌ Error updating push token:', err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = router;
