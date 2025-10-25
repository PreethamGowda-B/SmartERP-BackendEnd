const express = require("express")
const router = express.Router()
const bcrypt = require("bcrypt")
const jwt = require("jsonwebtoken")
const { pool } = require("../db")
const logActivity = require("../helpers/logActivity")

require("dotenv").config()

if (!process.env.JWT_SECRET) {
  console.error("❌ ERROR: JWT_SECRET environment variable is not set!")
  process.exit(1)
}

// Choose refresh secret
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET

// --------------------
// Login route
// --------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" })
  }

  try {
    const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email])
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" })
    }
    const user = userResult.rows[0]
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return res.status(401).json({ message: "Invalid credentials" })
    }

    // Log login activity
    await logActivity(user.id, "login", req)

    const accessToken = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "15m" })
    const refreshToken = jwt.sign({ userId: user.id, role: user.role }, REFRESH_SECRET, { expiresIn: "7d" })

    // Store refresh token
    await pool.query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
      [user.id, refreshToken],
    )

    // Set cookies
    const cookieOptions = { httpOnly: true, sameSite: "lax" }
    res.cookie("access_token", accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 })
    res.cookie("refresh_token", refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 })

    res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } })
  } catch (err) {
    console.error("Login error", err)
    res.status(500).json({ message: "Server error" })
  }
})

// --------------------
// Refresh token route
// --------------------
router.post("/refresh", async (req, res) => {
  const token = req.cookies?.refresh_token
  if (!token) return res.status(401).json({ message: "No refresh token" })

  try {
    const rt = await pool.query("SELECT * FROM refresh_tokens WHERE token = $1", [token])
    if (rt.rows.length === 0) return res.status(401).json({ message: "Invalid refresh token" })

    jwt.verify(token, REFRESH_SECRET, async (err, payload) => {
      if (err) return res.status(403).json({ message: "Invalid token" })

      try {
        // Rotate refresh token
        await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [token])
        const newRefresh = jwt.sign({ userId: payload.userId, role: payload.role }, REFRESH_SECRET, { expiresIn: "7d" })
        await pool.query(
          "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
          [payload.userId, newRefresh],
        )

        const accessToken = jwt.sign({ userId: payload.userId, role: payload.role }, process.env.JWT_SECRET, {
          expiresIn: "15m",
        })

        res.cookie("access_token", accessToken, { httpOnly: true, sameSite: "lax", maxAge: 15 * 60 * 1000 })
        res.cookie("refresh_token", newRefresh, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 })

        // Log refresh activity
        await logActivity(payload.userId, "refresh_token", req)

        res.json({ ok: true })
      } catch (err) {
        console.error("Error rotating token", err)
        res.status(500).json({ message: "Server error" })
      }
    })
  } catch (err) {
    console.error("Refresh error", err)
    res.status(500).json({ message: "Server error" })
  }
})

// --------------------
// Logout route
// --------------------
router.post("/logout", async (req, res) => {
  try {
    const token = req.cookies?.refresh_token
    if (token) {
      const rt = await pool.query("SELECT * FROM refresh_tokens WHERE token = $1", [token])
      if (rt.rows.length) {
        const userId = rt.rows[0].user_id
        await logActivity(userId, "logout", req)
      }

      await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [token])
    }

    res.clearCookie("access_token")
    res.clearCookie("refresh_token")
    res.json({ ok: true })
  } catch (err) {
    console.error("Logout error", err)
    res.status(500).json({ message: "Server error" })
  }
})

// --------------------
// Test route
// --------------------
router.get("/", (req, res) => {
  res.json({ message: "Auth route is working!" })
})

module.exports = router
