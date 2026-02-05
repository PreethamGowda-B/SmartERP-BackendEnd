require("dotenv").config(); // Load environment variables early

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { pool } = require("./db"); // ✅ Make sure db.js exports { pool }

const app = express();

// ✅ Trust proxy (required for HTTPS cookies on Render)
app.set("trust proxy", 1);

// ✅ FIXED: Dynamic CORS configuration that accepts all Vercel preview URLs
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like Postman or server-to-server)
      if (!origin) {
        return callback(null, true);
      }

      // List of explicitly allowed origins
      const allowedOrigins = [
        "http://localhost:3000",
        "https://smart-erp-front-end.vercel.app",
        "https://www.prozync.in",
        "https://prozync.in",
      ];

      // Check if origin is in allowed list
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // ✅ CRITICAL FIX: Allow ALL Vercel preview deployments
      // Pattern: https://smart-erp-front-*.vercel.app
      if (origin.match(/^https:\/\/smart-erp-front(-[a-z0-9]+)?(-[a-z0-9-]+)?\.vercel\.app$/)) {
        return callback(null, true);
      }

      // Also allow pattern: https://smart-erp-front-*-thepreethu01-9119s-projects.vercel.app
      if (origin.match(/^https:\/\/smart-erp-front-[a-z0-9]+-thepreethu01-9119s-projects\.vercel\.app$/)) {
        return callback(null, true);
      }

      console.warn("🚫 Blocked CORS request from:", origin);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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

// ✅ Serve uploaded files statically
app.use('/uploads', express.static('uploads'));

// Fix database constraints on startup
async function fixDatabaseConstraints() {
  try {
    console.log('🔧 Fixing database constraints...');

    // Step 1: Update any existing jobs with invalid status to 'open'
    const updateResult = await pool.query(`
      UPDATE jobs 
      SET status = 'open' 
      WHERE status NOT IN ('open', 'pending', 'in_progress', 'active', 'completed', 'closed', 'cancelled')
    `);
    if (updateResult.rowCount > 0) {
      console.log(`✅ Updated ${updateResult.rowCount} jobs with invalid status`);
    }

    // Step 2: Drop old constraint
    await pool.query(`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check`);

    // Step 3: Add new flexible constraint
    await pool.query(`
      ALTER TABLE jobs ADD CONSTRAINT jobs_status_check 
      CHECK (status IN ('open', 'pending', 'in_progress', 'active', 'completed', 'closed', 'cancelled'))
    `);

    console.log('✅ Database constraints fixed');
  } catch (err) {
    console.warn('⚠️  Could not fix constraints:', err.message);
  }
}
setTimeout(fixDatabaseConstraints, 3000); // Run after DB connection

// Auto-fix material_requests schema on startup
const { fixMaterialRequestsSchema } = require('./migrations/autoMigrate');
setTimeout(fixMaterialRequestsSchema, 4000); // Run after DB connection

// ✅ Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/jobs", require("./routes/jobs"));
app.use("/api/activities", require("./routes/activities"));
app.use("/api/attendance", require("./routes/attendance"));
app.use("/api/materials", require("./routes/materials"));
app.use("/api/inventory", require("./routes/inventory"));
app.use("/api/payroll", require("./routes/payroll"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/employees", require("./routes/employees"));
app.use("/api/employees-simple", require("./routes/employees-simple"));
app.use("/api/material-requests", require("./routes/materialRequests"));
app.use("/api/ai", require("./routes/ai.routes"));
app.use("/api/messages", require("./routes/messages"));



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
      <p>CORS: <strong>Configured for all Vercel deployments ✅</strong></p>
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
  console.log("🌐 CORS: Accepting all Vercel preview deployments");
});

module.exports = app;
