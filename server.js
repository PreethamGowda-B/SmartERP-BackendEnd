require("dotenv").config();
const Sentry = require("@sentry/node");
const { nodeProfilingIntegration } = require("@sentry/profiling-node");

// ✅ Initialize Sentry BEFORE anything else
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [
      nodeProfilingIntegration(),
    ],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
  });
  console.log("🎯 Sentry Observability initialized");
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const { pool } = require("./db"); // ✅ Make sure db.js exports { pool }

const app = express();

// ✅ Sentry Request Request Handler (MUST be first)
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

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

// ✅ CSRF Protection (Standard for Cookie-based Auth)
// We only enable it if a specific header or cookie is present to avoid breaking existing clients immediately,
// but for a clean v1, we should be strict.
if (process.env.NODE_ENV === "production") {
  const csrf = require("csurf");
  const csrfProtection = csrf({ 
    cookie: {
      httpOnly: false, // Must be accessible to frontend if reading 'XSRF-TOKEN' header
      secure: true,
      sameSite: 'none'
    } 
  });

  app.use((req, res, next) => {
    const publicRoutes = [
      '/api/auth/login',
      '/api/v1/auth/login',
      '/api/auth/signup',
      '/api/v1/auth/signup',
      '/api/health',
      '/api/v1/health',
      '/api/csrf-token',
      '/api/notifications/devices',
      '/api/v1/notifications/devices'
    ];

    // 🛡️ Skip CSRF validation for:
    // 1. Bearer token requests (Safe: attackers can't set custom headers)
    // 2. Public auth routes (Initial entry points)
    if (
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) ||
      publicRoutes.includes(req.path)
    ) {
      return next();
    }

    csrfProtection(req, res, next);
  });

  // Provide token via cookie for all requests to enable CSRF for cookie-only clients if needed later
  app.use((req, res, next) => {
    try {
      if (req.csrfToken) {
        res.cookie('XSRF-TOKEN', req.csrfToken(), {
          secure: true,
          sameSite: 'none'
        });
      }
    } catch (e) {
      // req.csrfToken() might throw if not initialized, ignore
    }
    next();
  });
}

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
// ✅ Consolidated Database Initialization (Run once per deployment)
async function runDatabaseInitialization() {
  try {
    console.log('🏗️  Starting Database Initialization...');
    
    // 1. Fix constraints
    await fixDatabaseConstraints();
    
    // 2. Auto-migrate schema
    const { fixMaterialRequestsSchema } = require('./migrations/autoMigrate');
    await fixMaterialRequestsSchema();
    
    // 3. OTP setup and Core optimization
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

      -- Update activities table for modern logging
      ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_type TEXT;
      ALTER TABLE activities ADD COLUMN IF NOT EXISTS details JSONB;
      ALTER TABLE activities ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
    `);
    
    const { optimizeDatabase } = require('./scripts/optimizeDb');
    await optimizeDatabase();
    
    console.log('✅ Database Initialization & Optimization complete');
  } catch (err) {
    console.error('❌ Database Initialization failed:', err.message);
  }
}

// ✅ API Versioning (v1)
const v1Router = express.Router();
const { setTenantContext } = require("./middleware/tenantContext");

v1Router.use(setTenantContext); // Enforce RLS for all v1 routes

v1Router.use("/auth", require("./routes/auth"));
v1Router.use("/users", require("./routes/users"));
v1Router.use("/jobs", require("./routes/jobs"));
v1Router.use("/activities", require("./routes/activities"));
v1Router.use("/attendance", require("./routes/attendance"));
v1Router.use("/materials", require("./routes/materials"));
v1Router.use("/inventory", require("./routes/inventory"));
v1Router.use("/payroll", require("./routes/payroll"));
v1Router.use("/notifications", require("./routes/notifications"));
v1Router.use("/payments", require("./routes/payments"));
v1Router.use("/analytics", require("./routes/analytics"));
v1Router.use("/employees", require("./routes/employees"));
v1Router.use("/employees-simple", require("./routes/employees-simple"));
v1Router.use("/material-requests", require("./routes/materialRequests"));
v1Router.use("/ai", require("./routes/ai.routes"));
v1Router.use("/messages", require("./routes/messages"));
v1Router.use("/dashboard", require("./routes/dashboard"));
v1Router.use("/reports", require("./routes/reports"));
v1Router.use("/settings", require("./routes/settings"));
v1Router.use("/location", require("./routes/location"));
v1Router.use("/subscription", require("./routes/subscription"));

// Mount v1 router
app.use("/api/v1", v1Router);
app.use("/api", v1Router); // Fallback for backward compatibility




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
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

app.use((err, req, res, next) => {
  // Handle CSRF errors specifically
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ message: "Invalid CSRF token. Please refresh the page." });
  }
  
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

const cluster = require('cluster');
const totalCPUs = require('os').cpus().length;
// Cap workers to prevent OOM on Render's 512MB RAM limit
// We recommend 2 workers for 512MB, 4 for 1GB.
const WORKER_COUNT = process.env.WEB_CONCURRENCY || Math.min(totalCPUs, 2);

if (cluster.isMaster && process.env.NODE_ENV === 'production') {
  console.log(`📡 Master process ${process.pid} is running`);
  console.log(`🧵 Spawning ${WORKER_COUNT} workers for cluster mode...`);

  // Run DB initialization ONCE in the master process before forking
  (async () => {
    try {
      await runDatabaseInitialization();
    } catch (err) {
      console.error('❌ Master DB Init Error:', err.message);
    }
    
    for (let i = 0; i < WORKER_COUNT; i++) {
      cluster.fork();
    }
  })();

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`⚠️ Worker ${worker.process.pid} died. Spawning replacement...`);
    cluster.fork();
  });

} else {
  // ✅ Start server
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`🚀 SmartERP worker ${process.pid} running on port ${PORT}`);
    
    // Only run background workers and periodic jobs on worker 1
    if (!cluster.isWorker || cluster.worker.id === 1) {
      console.log("🛠️ Starting background processors and workers on worker 1...");
      
      require('./jobs/workers'); // Initialize BullMQ workers

      try {
        const { startDailyAttendanceProcessor } = require('./jobs/dailyAttendanceProcessor');
        startDailyAttendanceProcessor();
      } catch (err) {
        console.error('❌ Failed to start daily attendance processor:', err.message);
      }

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
          const { pool } = require("./db");
          const result = await pool.query(
            "SELECT id, company_id FROM users WHERE push_token IS NOT NULL AND role = 'owner' ORDER BY RANDOM() LIMIT 5"
          );

          for (const user of result.rows) {
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
    }
  });
}

module.exports = app;
