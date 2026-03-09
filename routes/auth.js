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
require("dotenv").config();

// JWT secrets
const ACCESS_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || ACCESS_SECRET;

// ---------------------------------------------
// ✅ Google OAuth Strategy Configuration
// ---------------------------------------------
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/api/auth/google/callback",
      passReqToCallback: true, // ✅ Allow access to req in callback
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails[0].value;
        const googleId = profile.id;
        const name = profile.displayName;

        // Extract role and company_code from state (passed from frontend)
        let role = "owner";
        let company_code = null;

        if (req.query.state) {
          try {
            const stateData = JSON.parse(Buffer.from(req.query.state, 'base64').toString());
            if (stateData.role) role = stateData.role;
            if (stateData.company_code) company_code = stateData.company_code;
          } catch (e) {
            // Ignore parse error
          }
        }

        // Check if user exists
        let userResult = await pool.query("SELECT * FROM users WHERE google_id = $1 OR email = $2", [
          googleId,
          email,
        ]);

        let user;
        let companyId = null;
        let companyCode = null;

        if (userResult.rows.length > 0) {
          // Existing user - just link Google ID if needed
          user = userResult.rows[0];

          if (!user.google_id) {
            await pool.query("UPDATE users SET google_id = $1 WHERE id = $2", [googleId, user.id]);
            user.google_id = googleId;
          }
        } else {
          // New user - handle company creation/linking

          // OWNER FLOW: Auto-create company
          if (role === 'owner') {
            const { generateCompanyId } = require('../utils/companyIdGenerator');
            companyCode = await generateCompanyId();
            const companyName = `${name}'s Company`;

            const companyResult = await pool.query(
              `INSERT INTO companies (company_id, company_name, created_at)
               VALUES ($1, $2, NOW())
               RETURNING id, company_id`,
              [companyCode, companyName]
            );

            companyId = companyResult.rows[0].id;
            console.log(`✅ Created company ${companyCode} for Google owner ${email}`);
          }

          // EMPLOYEE FLOW: Validate and link to company
          if (role === 'employee') {
            if (company_code) {
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
          }

          // Create new user with company linkage
          const insertResult = await pool.query(
            `INSERT INTO users (name, email, google_id, role, company_id, company_code, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             RETURNING *`,
            [name, email, googleId, role, companyId, companyCode]
          );
          user = insertResult.rows[0];

          // If owner, update company with owner_id
          if (role === 'owner' && companyId) {
            await pool.query(
              'UPDATE companies SET owner_id = $1 WHERE id = $2',
              [user.id, companyId]
            );
          }
        }

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

// ---------------------------------------------
// ✅ Google OAuth Routes
// ---------------------------------------------

// Initiate Google Login
router.get(
  "/google",
  (req, res, next) => {
    const role = req.query.role || "owner";
    const company_code = req.query.company_code || null;
    const state = Buffer.from(JSON.stringify({ role, company_code })).toString('base64');

    passport.authenticate("google", {
      scope: ["profile", "email"],
      session: false,
      state: state // ✅ Pass role and company_code in state
    })(req, res, next);
  }
);

// Handle Google Callback
router.get(
  "/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: "/login" }),
  async (req, res) => {
    try {
      const user = req.user;

      // Log activity
      await logActivity(user.id, "login_google", req);

      // Generate Tokens
      const accessToken = jwt.sign(
        { id: user.id, userId: user.id, role: user.role, companyId: user.company_id },
        ACCESS_SECRET,
        { expiresIn: "15m" }
      );
      const refreshToken = jwt.sign(
        { id: user.id, userId: user.id },
        REFRESH_SECRET,
        { expiresIn: "7d" }
      );

      // Store Refresh Token in DB
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
        [user.id, refreshToken]
      );

      // Redirect to frontend with tokens
      const frontendUrl = process.env.FRONTEND_ORIGIN || "https://smart-erp-front-end.vercel.app";
      res.redirect(
        `${frontendUrl}/auth/callback?accessToken=${accessToken}&refreshToken=${refreshToken}&user=${encodeURIComponent(
          JSON.stringify({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            companyId: user.company_id
          })
        )}`
      );
    } catch (err) {
      console.error("Google Auth Error:", err);
      res.redirect("/login?error=auth_failed");
    }
  }
);


// ---------------------------------------------
// ✅ Send OTP for email verification (signup only)
// ---------------------------------------------
router.post("/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });

  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set");
    return res.status(500).json({ message: "Email service not configured. Contact support." });
  }

  try {
    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Ensure email_otps table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_otps (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        otp_code VARCHAR(6) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Delete any old unused OTPs for this email
    await pool.query("DELETE FROM email_otps WHERE email = $1", [email]);

    // Store new OTP
    await pool.query(
      "INSERT INTO email_otps (email, otp_code, expires_at) VALUES ($1, $2, $3)",
      [email, otp, expiresAt]
    );

    // Send email via Resend HTTP API
    const resend = new Resend(process.env.RESEND_API_KEY);
    const sendResult = await resend.emails.send({
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
// ✅ Verify OTP
// ---------------------------------------------
router.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: "Email and OTP are required" });

  try {
    const result = await pool.query(
      "SELECT * FROM email_otps WHERE email = $1 AND otp_code = $2 AND used = FALSE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
      [email, otp.toString().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired OTP. Please request a new one." });
    }

    // Mark OTP as used
    await pool.query("UPDATE email_otps SET used = TRUE WHERE id = $1", [result.rows[0].id]);

    console.log(`✅ OTP verified for ${email}`);
    res.json({ ok: true, verified: true, message: "Email verified successfully" });
  } catch (err) {
    console.error("Verify OTP error:", err.message);
    res.status(500).json({ message: "Verification failed. Please try again." });
  }
});

// ---------------------------------------------
// ✅ Signup (Register New Users)
// ---------------------------------------------
router.post("/signup", async (req, res) => {
  const { name, email, password, role = "owner", phone, position, department, company_code } = req.body;

  try {
    // ✅ Check email was verified via OTP before allowing signup
    const otpCheck = await pool.query(
      "SELECT * FROM email_otps WHERE email = $1 AND used = TRUE AND created_at > NOW() - INTERVAL '15 minutes' ORDER BY created_at DESC LIMIT 1",
      [email]
    ).catch(() => ({ rows: [] })); // gracefully skip if table missing

    if (otpCheck.rows.length === 0) {
      return res.status(403).json({ message: "Email not verified. Please verify your email with OTP before signing up." });
    }

    const existing = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "Email already exists" });
    }


    const hashedPassword = await bcrypt.hash(password, 10);
    let companyId = null;
    let companyCode = null;
    let companyName = null;

    // ✅ OWNER FLOW: Auto-create company
    if (role.toLowerCase() === 'owner') {
      const { generateCompanyId } = require('../utils/companyIdGenerator');

      // Generate unique company ID
      companyCode = await generateCompanyId();
      companyName = `${name}'s Company` || 'My Company';

      // Create company (owner_id will be set after user creation)
      const companyResult = await pool.query(
        `INSERT INTO companies (company_id, company_name, created_at)
         VALUES ($1, $2, NOW())
         RETURNING id, company_id`,
        [companyCode, companyName]
      );

      companyId = companyResult.rows[0].id;
      console.log(`✅ Created company ${companyCode} for owner ${email}`);
    }

    // ✅ EMPLOYEE FLOW: Validate and link to company
    if (role.toLowerCase() === 'employee') {
      if (!company_code) {
        return res.status(400).json({
          message: "Company code is required for employee registration"
        });
      }

      const { validateCompanyCode } = require('../utils/companyIdGenerator');
      const validation = await validateCompanyCode(company_code);

      if (!validation.valid) {
        return res.status(400).json({
          message: "Invalid company code. Please check with your employer."
        });
      }

      companyId = validation.company.id;
      companyCode = validation.company.company_id;
      companyName = validation.company.company_name;
      console.log(`✅ Employee ${email} validated for company ${companyCode}`);
    }

    // Create user with company linkage
    const insert = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone, position, department, company_id, company_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING id, name, email, role, phone, position, department, company_id, company_code, created_at`,
      [name, email, hashedPassword, role.toLowerCase(), phone || null, position || null, department || null, companyId, companyCode]
    );

    const user = insert.rows[0];

    // ✅ If owner, update company with owner_id
    if (role.toLowerCase() === 'owner' && companyId) {
      await pool.query(
        'UPDATE companies SET owner_id = $1 WHERE id = $2',
        [user.id, companyId]
      );
    }

    await logActivity(user.id, "signup", req);

    // Send notification to owner if employee registered
    if (role.toLowerCase() === 'employee' && companyId) {
      try {
        const { createNotificationForOwners } = require('../utils/notificationHelpers');

        await createNotificationForOwners({
          company_id: companyId,
          type: 'employee_registration',
          title: 'New Employee Registered',
          message: `${name || email} joined your company`,
          priority: 'medium',
          data: { employee_id: user.id, employee_email: email, company_code: companyCode }
        });

        console.log(`✅ Notified owners about new employee: ${email}`);
      } catch (notifErr) {
        console.error('❌ Failed to send employee registration notification:', notifErr);
      }
    }

    // Return user info with company details
    res.status(201).json({
      ok: true,
      user: {
        ...user,
        company_name: companyName
      },
      company_code: companyCode  // Return company code for owner to share
    });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ message: "Server error during signup" });
  }
});

// ---------------------------------------------
// ✅ Login Route
// ---------------------------------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const user = result.rows[0];

    // Check if user has a password (google-only users won't)
    if (!user.password_hash) {
      return res.status(401).json({ message: "Please log in with Google" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    await logActivity(user.id, "login", req);

    // Generate JWTs
    const accessToken = jwt.sign(
      { id: user.id, userId: user.id, role: user.role, companyId: user.company_id },
      ACCESS_SECRET,
      { expiresIn: "15m" }
    );
    const refreshToken = jwt.sign(
      { id: user.id, userId: user.id },
      REFRESH_SECRET,
      { expiresIn: "7d" }
    );

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshToken]
    );

    // ✅ Cookie config for same-domain scenarios (optional fallback)
    const cookieOpts = {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    };

    res.cookie("access_token", accessToken, { ...cookieOpts, maxAge: 15 * 60 * 1000 });
    res.cookie("refresh_token", refreshToken, { ...cookieOpts, maxAge: 7 * 24 * 60 * 60 * 1000 });

    console.log("✅ Login successful for user:", user.email);

    delete user.password_hash;

    // ✅ CRITICAL: Return tokens in response body for cross-domain auth
    res.json({
      ok: true,
      user,
      accessToken,  // Frontend will store this in localStorage
      refreshToken  // Frontend will store this in localStorage
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ message: "Server error during login" });
  }
});

// ---------------------------------------------
// ✅ Refresh Token Route
// ---------------------------------------------
router.post("/refresh", async (req, res) => {
  // Try cookie first, then request body (for cross-domain scenarios)
  const token = req.cookies?.refresh_token || req.body?.refreshToken;
  if (!token) return res.status(401).json({ message: "No refresh token provided" });

  try {
    const result = await pool.query("SELECT * FROM refresh_tokens WHERE token = $1", [token]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    jwt.verify(token, REFRESH_SECRET, async (err, payload) => {
      if (err) return res.status(403).json({ message: "Invalid token" });

      try {
        // Support old refresh tokens that only had `id` (not `userId`) in payload
        const payloadUserId = payload.userId || payload.id;
        if (!payloadUserId) return res.status(401).json({ message: "Invalid token payload" });

        // ✅ Fetch user role and company_id from database
        const userResult = await pool.query("SELECT role, company_id FROM users WHERE id = $1", [payloadUserId]);
        if (userResult.rows.length === 0) {
          return res.status(401).json({ message: "User not found" });
        }
        const userRole = userResult.rows[0].role;
        const userCompanyId = userResult.rows[0].company_id;

        await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [token]);
        const newRefresh = jwt.sign({ id: payloadUserId, userId: payloadUserId }, REFRESH_SECRET, { expiresIn: "7d" });
        await pool.query(
          `INSERT INTO refresh_tokens (user_id, token, expires_at)
           VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
          [payloadUserId, newRefresh]
        );

        // ✅ Include role and companyId in access token
        const accessToken = jwt.sign(
          { id: payloadUserId, userId: payloadUserId, role: userRole, companyId: userCompanyId },
          ACCESS_SECRET,
          { expiresIn: "15m" }
        );

        // ✅ Updated cookie settings (same as /login)
        const cookieOpts = {
          httpOnly: true,
          sameSite: "none",
          secure: true,
        };

        res.cookie("access_token", accessToken, { ...cookieOpts, maxAge: 15 * 60 * 1000 });
        res.cookie("refresh_token", newRefresh, { ...cookieOpts, maxAge: 7 * 24 * 60 * 60 * 1000 });

        await logActivity(payload.userId, "refresh_token", req);

        // ✅ Return tokens in response body for cross-domain auth
        res.json({
          ok: true,
          accessToken,
          refreshToken: newRefresh
        });
      } catch (error) {
        console.error("Token rotation error:", error);
        res.status(500).json({ message: "Server error during token refresh" });
      }
    });
  } catch (err) {
    console.error("Refresh route error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------------------------------------------
// ✅ Logout Route
// ---------------------------------------------
router.post("/logout", async (req, res) => {
  try {
    // Accept refresh token from cookie OR request body (for cross-domain auth)
    const token = req.cookies?.refresh_token || req.body?.refreshToken;

    if (token) {
      const rt = await pool.query("SELECT * FROM refresh_tokens WHERE token = $1", [token]);
      if (rt.rows.length) {
        const userId = rt.rows[0].user_id;
        await logActivity(userId, "logout", req);
      }
      await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [token]);
    }

    // ✅ Clear cookies properly for cross-site setup
    res.clearCookie("access_token", { sameSite: "none", secure: true });
    res.clearCookie("refresh_token", { sameSite: "none", secure: true });

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

    if (!pushToken) {
      return res.status(400).json({ message: 'Push token is required' });
    }

    await pool.query(
      'UPDATE users SET push_token = $1 WHERE id = $2',
      [pushToken, userId]
    );

    console.log(`✅ Push token updated for user ${userId}`);
    res.json({ message: 'Push token updated successfully' });
  } catch (err) {
    console.error('❌ Error updating push token:', err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = router;
