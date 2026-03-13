require("dotenv").config(); // Load environment variables early

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const { pool } = require("./db"); // ✅ Make sure db.js exports { pool }

const app = express();

// ✅ CORS configuration — MUST be before rate limiters and other security headers
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      "http://localhost:3000",
      "https://smart-erp-front-end.vercel.app",
      "https://www.prozync.in",
      "https://prozync.in",
    ];

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    if (origin.match(/^https:\/\/smart-erp-front(-[a-z0-9]+)?(-[a-z0-9-]+)?\.vercel\.app$/)) {
      return callback(null, true);
    }
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
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ✅ Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// ✅ Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Strict for login/signup
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // More relaxed for status checks
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);
app.use("/api/auth/refresh", authLimiter);
app.use("/api/subscription", apiLimiter); // ✅ Relaxed limit for subs
app.use("/api/payments", apiLimiter);

// ✅ Trust proxy (required for HTTPS cookies on Render)
app.set("trust proxy", 1);

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

// 🚀 Performance Optimization & Schema Verification
const { optimizeDatabase } = require('./scripts/optimizeDb');
setTimeout(async () => {
  try {
    // Ensure essential tables that might be missing from older setups exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_otps (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        otp_code VARCHAR(6) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps(email);
    `);
    
    await optimizeDatabase();
    console.log('✅ Database optimization complete');
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
  }
}, 6000); // Run after DB connections and migrations

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
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/location", require("./routes/location"));
app.use("/api/subscription", require("./routes/subscription"));




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

// ✅ Global Error Handler (MUST BE LAST)
app.use((err, req, res, next) => {
  console.error("❌ Global Error:", err.stack);
  res.status(err.status || 500).json({
    message: err.message || "An internal server error occurred.",
    error: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// ✅ Catch uncaught exceptions to prevent silent process death
process.on("uncaughtException", (err) => {
  console.error("🔥 UNCAUGHT EXCEPTION:", err);
  // Ideally, restart or exit after logging
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 UNHANDLED REJECTION at:", promise, "reason:", reason);
});

// ✅ Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 SmartERP backend running on port ${PORT}`);
  console.log("🌐 CORS: Accepting all Vercel preview deployments");

  // ✅ Start daily attendance processor (7:30 PM IST)
  try {
    const { startDailyAttendanceProcessor } = require('./jobs/dailyAttendanceProcessor');
    startDailyAttendanceProcessor();
  } catch (err) {
    console.error('❌ Failed to start daily attendance processor:', err.message);
  }

  // ✅ Start trial expiry processor (9:00 AM IST)
  try {
    const { startTrialExpiryProcessor } = require('./jobs/trialExpiryProcessor');
    startTrialExpiryProcessor();
  } catch (err) {
    console.error('❌ Failed to start trial expiry processor:', err.message);
  }

  // 🔔 Smart Notification Service: Send tips/pokes periodically
  const { sendRandomTip, sendRandomPoke } = require("./services/smartNotificationService");
  setInterval(async () => {
    try {
      console.log("🕒 Running Smart Notification Check...");
      const { pool } = require("./db");
      const result = await pool.query(
        "SELECT id, company_id FROM users WHERE push_token IS NOT NULL AND role = 'owner' ORDER BY RANDOM() LIMIT 5"
      );

      for (const user of result.rows) {
        // 1. Check if attendance has been marked for his company today
        const attendanceCheck = await pool.query(
          "SELECT id FROM attendance WHERE company_id = $1 AND date = CURRENT_DATE LIMIT 1",
          [user.company_id]
        );

        if (attendanceCheck.rows.length === 0) {
          const { sendSmartNotification } = require("./services/smartNotificationService");
          await sendSmartNotification(user.id, user.company_id, {
            title: "📅 Attendance Reminder",
            message: "Attendance hasn't been marked today. Don't forget to check!",
            type: "reminder_attendance",
            priority: "medium",
            data: { url: "/owner/attendance" }
          });
        }

        // 2. 50/50 chance of tip vs poke (Engagement)
        if (Math.random() > 0.5) {
          await sendRandomTip(user.id, user.company_id);
        } else {
          await sendRandomPoke(user.id, user.company_id);
        }
      }
    } catch (err) {
      console.error("❌ Smart Notification Background Job Error:", err.message);
    }
  }, 6 * 60 * 60 * 1000); // Every 6 hours
});

module.exports = app;
