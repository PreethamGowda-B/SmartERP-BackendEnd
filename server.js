require("dotenv").config(); // Load environment variables early

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { pool } = require("./db"); // ✅ Make sure db.js exports { pool }

const app = express();

// ✅ Trust proxy (required for HTTPS cookies on Render)
app.set("trust proxy", 1);

// ✅ Proper CORS configuration
const allowedOrigins = [
  "http://localhost:3000",
  "https://smart-erp-front-end.vercel.app",
  "https://smart-erp-front-dogibjmtv-thepreethu01-9119s-projects.vercel.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like Postman or server-to-server)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("🚫 Blocked CORS request from:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Set-Cookie"],
    optionsSuccessStatus: 200,
  })
);

// ✅ Handle preflight requests globally
app.options("*", cors());

// ✅ Common middlewares
app.use(cookieParser());
app.use(express.json());

// ✅ Routes
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

// ✅ Health check route
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

// ✅ Info route
app.get("/api", (req, res) => {
  res.json({
    message: "🚀 SmartERP Backend API is running successfully!",
    database: "connected",
    base: "/api",
    frontend: process.env.FRONTEND_ORIGIN,
  });
});

// ✅ Root (for Render homepage)
app.get("/", async (req, res) => {
  try {
    await pool.query("SELECT NOW()");
    res.send(`
      <h1>SmartERP Backend</h1>
      <p>Status: <strong>OK ✅</strong></p>
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

// ✅ Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 SmartERP backend running on port ${PORT}`);
  console.log("🌐 Allowed origins:", allowedOrigins);
});

module.exports = app;
