const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const router = express.Router();
const cookieParser = require("cookie-parser");
require("dotenv").config();


const ACCESS_SECRET = process.env.JWT_SECRET || "supersecretkey";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || ACCESS_SECRET;

// ================================
// Utility: create JWT tokens
// ================================
function createAccessToken(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: "15m" });
}
function createRefreshToken(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: "7d" });
}

// ================================
// Register user
// ================================
router.post("/register", async (req, res) => {
  try {
    const { email, password, role = "employee" } = req.body;

    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required" });

    const userExists = await pool.query("SELECT id FROM users WHERE email = $1", [
      email.toLowerCase(),
    ]);
    if (userExists.rows.length > 0)
      return res.status(409).json({ message: "Account already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role",
      [email.toLowerCase(), hashedPassword, role]
    );

    res.status(201).json({
      message: "Account created successfully",
      user: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Register error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ================================
// Login user
// ================================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required" });

    const userResult = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email.toLowerCase()]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ message: "Invalid credentials" });

    const payload = { id: user.id, email: user.email, role: user.role };
    const accessToken = createAccessToken(payload);
    const refreshToken = createRefreshToken(payload);

    // Store tokens as cookies
    const cookieOptions = {
      httpOnly: true,
      sameSite: "lax",
      // secure: process.env.NODE_ENV === "production",
    };
    res.cookie("access_token", accessToken, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000,
    });
    res.cookie("refresh_token", refreshToken, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Login successful",
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ================================
// Refresh Token
// ================================
router.post("/refresh", async (req, res) => {
  try {
    const token = req.cookies?.refresh_token || req.body.refresh_token;
    if (!token) return res.status(401).json({ message: "No refresh token" });

    jwt.verify(token, REFRESH_SECRET, (err, decoded) => {
      if (err) return res.status(401).json({ message: "Invalid refresh token" });
      const newAccess = createAccessToken({
        id: decoded.id,
        email: decoded.email,
        role: decoded.role,
      });
      res.cookie("access_token", newAccess, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 15 * 60 * 1000,
      });
      res.json({ message: "Token refreshed" });
    });
  } catch (err) {
    console.error("Refresh token error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ================================
// Logout
// ================================
router.post("/logout", (req, res) => {
  res.clearCookie("access_token");
  res.clearCookie("refresh_token");
  res.json({ message: "Logged out successfully" });
});

// ================================
// Test route
// ================================
router.get("/", (req, res) => {
  res.json({ message: "Auth API is working fine ✅" });
});

module.exports = router;
