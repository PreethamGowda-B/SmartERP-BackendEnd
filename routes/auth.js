const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const logActivity = require("../helpers/logActivity");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
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

        // Extract role from state (passed from frontend)
        // Passport decodes the state, but we need to handle it in the callback wrapper usually.
        // However, with passReqToCallback, we might not get the state directly in req.query.state if passport consumes it.
        // The standard way in passport-google-oauth20 is to pass state in the authenticate options.
        // Let's rely on the fact that we will decode the state parameter in the callback handler if needed,
        // OR we can trust that for new users, we default to 'owner' if not specified, but we want 'employee'.

        // BETTER APPROACH: The state is base64 encoded by passport usually or just passed through.
        // We will read the role from the decoded state in the route handler, NOT here in the strategy verify callback, 
        // because the verify callback focus is on finding/creating the user. 
        // BUT we need the role to create the user. 

        // Let's parse the state from req.query.state manually if available
        let role = "owner";
        if (req.query.state) {
          try {
            // Passort-oauth2 passes state as is.
            const stateData = JSON.parse(Buffer.from(req.query.state, 'base64').toString());
            if (stateData.role) role = stateData.role;
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

        if (userResult.rows.length > 0) {
          user = userResult.rows[0];

          // If user exists but no google_id, link it
          if (!user.google_id) {
            await pool.query("UPDATE users SET google_id = $1 WHERE id = $2", [googleId, user.id]);
            user.google_id = googleId;
          }
        } else {
          // Create new user if not exists
          const insertResult = await pool.query(
            `INSERT INTO users (name, email, google_id, role, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             RETURNING *`,
            [name, email, googleId, role]
          );
          user = insertResult.rows[0];
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
    const state = Buffer.from(JSON.stringify({ role })).toString('base64');

    passport.authenticate("google", {
      scope: ["profile", "email"],
      session: false,
      state: state // ✅ Pass role in state
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
// ✅ Signup (Register New Users)
// ---------------------------------------------
router.post("/signup", async (req, res) => {
  const { name, email, password, role = "owner", phone, position, department } = req.body;

  try {
    const existing = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const insert = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone, position, department, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id, name, email, role, phone, position, department, created_at`,
      [name, email, hashedPassword, role.toLowerCase(), phone || null, position || null, department || null]
    );

    const user = insert.rows[0];
    await logActivity(user.id, "signup", req);

    res.status(201).json({ ok: true, user });
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
        // ✅ Fetch user role and company_id from database
        const userResult = await pool.query("SELECT role, company_id FROM users WHERE id = $1", [payload.userId]);
        if (userResult.rows.length === 0) {
          return res.status(401).json({ message: "User not found" });
        }
        const userRole = userResult.rows[0].role;
        const userCompanyId = userResult.rows[0].company_id;

        await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [token]);
        const newRefresh = jwt.sign({ id: payload.userId, userId: payload.userId }, REFRESH_SECRET, { expiresIn: "7d" });
        await pool.query(
          `INSERT INTO refresh_tokens (user_id, token, expires_at)
           VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
          [payload.userId, newRefresh]
        );

        // ✅ Include role and companyId in access token
        const accessToken = jwt.sign(
          { id: payload.userId, userId: payload.userId, role: userRole, companyId: userCompanyId },
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
    const token = req.cookies?.refresh_token;

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
// ✅ Test Route
// ---------------------------------------------
router.get("/", (req, res) => {
  res.json({ message: "Auth API working fine ✅" });
});

module.exports = router;
