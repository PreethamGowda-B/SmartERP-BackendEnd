// backend/routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const logActivity = require("../helpers/logActivity");

require("dotenv").config();

// JWT secrets
const ACCESS_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || ACCESS_SECRET;

// --------------------
// ✅ Register (Signup) route
// --------------------
router.post("/register", async (req, res) => {
  const { name, email, password, role = "owner", phone, position, department } = req.body;

  try {
    // Check if user already exists
    const existingUser = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: "Email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new user
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone, position, department)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, email, role, phone, position, department`,
      [name, email, hashedPassword, role, phone, position, department]
    );

    const user = result.rows[0];

    // Log signup activity
    await logActivity(user.id, "signup", req);

    return res.status(201).json({ ok: true, user });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ message: "Server error during signup" });
  }
});

// --------------------
// ✅ Login route
// --------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = userResult.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Log login activity
    await logActivity(user.id, "login", req);

    // Create tokens
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      ACCESS_SECRET,
      { expiresIn: "15m" }
    );
    const refreshToken = jwt.sign(
      { userId: user.id },
      REFRESH_SECRET,
      { expiresIn: "7d" }
    );

    // Store refresh token
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshToken]
    );

    // Set cookies
    const cookieOpts = { httpOnly: true, sameSite: "lax" };
    res.cookie("access_token", accessToken, { ...cookieOpts, maxAge: 15 * 60 * 1000 });
    res.cookie("refresh_token", refreshToken, { ...cookieOpts, maxAge: 7 * 24 * 60 * 60 * 1000 });

    delete user.password_hash;
    return res.json({ ok: true, user });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ message: "Server error during login" });
  }
});

// --------------------
// ✅ Refresh token route
// --------------------
router.post("/refresh", async (req, res) => {
  const token = req.cookies?.refresh_token;
  if (!token) return res.status(401).json({ message: "No refresh token" });

  try {
    const rt = await pool.query("SELECT * FROM refresh_tokens WHERE token = $1", [token]);
    if (rt.rows.length === 0) return res.status(401).json({ message: "Invalid refresh token" });

    jwt.verify(token, REFRESH_SECRET, async (err, payload) => {
      if (err) return res.status(403).json({ message: "Invalid token" });

      try {
        // Rotate refresh token
        await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [token]);
        const newRefresh = jwt.sign({ userId: payload.userId }, REFRESH_SECRET, { expiresIn: "7d" });
        await pool.query(
          "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
          [payload.userId, newRefresh]
        );

        const accessToken = jwt.sign({ userId: payload.userId }, ACCESS_SECRET, { expiresIn: "15m" });

        res.cookie("access_token", accessToken, { httpOnly: true, sameSite: "lax", maxAge: 15 * 60 * 1000 });
        res.cookie("refresh_token", newRefresh, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });

        await logActivity(payload.userId, "refresh_token", req);

        return res.json({ ok: true });
      } catch (err) {
        console.error("Error rotating token:", err);
        return res.status(500).json({ message: "Server error" });
      }
    });
  } catch (err) {
    console.error("Refresh error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// --------------------
// ✅ Logout route
// --------------------
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

    res.clearCookie("access_token");
    res.clearCookie("refresh_token");
    return res.json({ ok: true });
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ message: "Server error during logout" });
  }
});

// --------------------
// ✅ Test route
// --------------------
router.get("/", (req, res) => {
  res.json({ message: "Auth route is working!" });
});

module.exports = router;
