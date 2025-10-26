const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

require("dotenv").config();

const ACCESS_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || ACCESS_SECRET;

// ✅ Cookie options for secure HTTPS
const cookieOptions = {
  httpOnly: true,
  sameSite: "none", // required for cross-domain cookies
  secure: true, // required for HTTPS (Render)
};

// --------------------
// ✅ Register (Signup)
// --------------------
router.post("/register", async (req, res) => {
  const { name, email, password, role = "OWNER" } = req.body;

  try {
    const exists = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (exists.rows.length > 0)
      return res.status(400).json({ message: "Email already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, email, role`,
      [email, hashedPassword, role.toUpperCase()]
    );

    const user = result.rows[0];
    return res.status(201).json({ ok: true, user });
  } catch (err) {
    console.error("Signup error:", err.message);
    return res.status(500).json({ message: "Server error during signup" });
  }
});

// --------------------
// ✅ Login
// --------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rows.length === 0)
      return res.status(401).json({ message: "Invalid email or password" });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ message: "Invalid email or password" });

    // ✅ Generate JWTs
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

    // ✅ Set secure cookies
    res.cookie("access_token", accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
    res.cookie("refresh_token", refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });

    return res.json({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ message: "Server error during login" });
  }
});

// --------------------
// ✅ Logout
// --------------------
router.post("/logout", async (req, res) => {
  try {
    res.clearCookie("access_token", cookieOptions);
    res.clearCookie("refresh_token", cookieOptions);
    return res.json({ ok: true, message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err.message);
    return res.status(500).json({ message: "Server error during logout" });
  }
});

// --------------------
// ✅ Health check
// --------------------
router.get("/", (req, res) => {
  res.json({ message: "Auth route active!" });
});

module.exports = router;
