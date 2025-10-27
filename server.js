require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { pool } = require("./db"); // ✅ make sure db.js exports { pool }

const app = express();

// ✅ Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "https://smart-erp-front-end.vercel.app",
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());

// ✅ Import routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/jobs", require("./routes/jobs"));
app.use("/api/activities", require("./routes/activities"));
app.use("/api/attendance", require("./routes/attendance"));
app.use("/api/materials", require("./routes/materials"));
app.use("/api/payroll", require("./routes/payroll"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/employees", require("./routes/employees"));

// ✅ Health Check Endpoint
app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      status: "ok",
      database: "connected",
      time: result.rows[0].now,
    });
  } catch (err) {
    console.error("❌ Health check failed:", err.message);
    res.status(500).json({
      status: "error",
      database: "disconnected",
      message: err.message,
    });
  }
});

// ✅ Root API JSON (for quick API info)
app.get("/api", (req, res) => {
  res.json({
    message: "🚀 SmartERP Backend API is running successfully!",
    database: "connected",
    base: "/api",
    frontend: process.env.FRONTEND_ORIGIN,
  });
});

// ✅ Root HTML page (for Render browser check)
app.get("/", async (req, res) => {
  try {
    await pool.query("SELECT NOW()");
    res.send(`
      <h1>SmartERP Backend</h1>
      <p>Status: <strong>OK</strong></p>
      <p>Database: <strong>Connected to Neon</strong></p>
      <p>API Base: <code>/api</code></p>
      <p>Server running on port ${process.env.PORT || 4000}</p>
    `);
  } catch (err) {
    console.error("❌ DB Connection Error:", err.message);
    res.status(500).send(`
      <h1>SmartERP Backend</h1>
      <p>Status: <strong>ERROR</strong></p>
      <p>Database: <strong>Disconnected</strong></p>
      <p>Error: ${err.message}</p>
    `);
  }
});

// ✅ Start Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 SmartERP backend running on port ${PORT}`);
});

module.exports = app;
