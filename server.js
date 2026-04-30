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
    tracesSampleRate: 0.1,
    profilesSampleRate: 0.1,
  });

  console.log("🎯 Sentry Observability initialized");
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const { pool } = require("./db"); // ✅ Make sure db.js exports { pool }
const logger = require("./utils/logger");

const app = express();

// ✅ Sentry Request Handling is now automatic in SDK v8+ 
// Just ensure Sentry.init() is called before any other code (done on line 7)

// ✅ CORS configuration — MUST be before rate limiters and other security headers
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      "http://localhost:3000",
      "https://smart-erp-front-end.vercel.app",
      "https://www.prozync.in",
      "https://prozync.in",
      "http://localhost:3001",
      "https://client.prozync.in",
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
  allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
  exposedHeaders: ["Set-Cookie"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ✅ Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.prozync.in", "https://prozync.in"],
      connectSrc: ["'self'", "https://smarterp-backendend.onrender.com", "https://www.prozync.in", "https://prozync.in", "https://*.firebaseio.com", "https://*.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" },
  dnsPrefetchControl: { allow: true },
}));

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

// Customer Portal auth rate limiter (20 req / 15 min per IP)
const customerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});
app.use("/api/customer/auth", customerAuthLimiter);
app.use("/api/v1/customer/auth", customerAuthLimiter);

// General API rate limiter — protects all other routes (300 req/15min per IP)
const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
  skip: (req) => {
    // Skip for already-limited auth routes
    return req.path.startsWith('/api/auth/') || req.path.startsWith('/api/v1/auth/');
  }
});
app.use("/api", generalApiLimiter);

// ✅ Trust proxy (required for HTTPS cookies on Render)
app.set("trust proxy", 1);

// ✅ Common middlewares
app.use(cookieParser());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// ✅ Passport — required for customer Google OAuth (customer-google strategy)
// session: false because we use stateless JWT cookies, not server-side sessions
const passport = require('passport');
app.use(passport.initialize());

// ✅ Anti-CSRF Protection (Stateless Alternative for SPAs)
// We enforce strong Cross-Origin checks for mutually secure cookies.
if (process.env.NODE_ENV === "production") {
  app.use((req, res, next) => {
    // Only mutable operations need CSRF protection
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const publicRoutes = [
      '/api/auth/login', '/api/v1/auth/login',
      '/api/auth/signup', '/api/v1/auth/signup',
      '/api/auth/refresh', '/api/v1/auth/refresh',
      '/api/health', '/api/v1/health',
      '/api/notifications/devices', '/api/v1/notifications/devices',
      '/api/auth/send-otp', '/api/v1/auth/send-otp',
      '/api/auth/verify-otp', '/api/v1/auth/verify-otp',
      '/api/auth/validate-company', '/api/v1/auth/validate-company',
      '/api/auth/set-cookie', '/api/v1/auth/set-cookie',
      '/api/webhook', '/api/v1/webhook'
    ];

    const normalizedPath = req.path.replace(/\/$/, '') || '/';
    const isPublic = publicRoutes.some(route => normalizedPath === route || normalizedPath.startsWith(route));

    // Header based authentication naturally deters CSRF.
    const hasTokenHeader = !!(req.headers.authorization && req.headers.authorization.startsWith('Bearer '));

    if (isPublic || hasTokenHeader) {
      return next();
    }

    // Origin Enforcement (Stateless CSRF Block)
    const origin = req.headers.origin;
    const referer = req.headers.referer;

    // Whitelisted explicit domains (same as your CORS)
    const allowedPatterns = [
      /^https:\/\/smart-erp-front(-[a-z0-9]+)?(-[a-z0-9-]+)?\.vercel\.app$/,
      /^https:\/\/smart-erp-front-[a-z0-9]+-thepreethu01-9119s-projects\.vercel\.app$/,
      /^https:\/\/www\.prozync\.in$/,
      /^https:\/\/prozync\.in$/,
      /^https:\/\/client\.prozync\.in$/,
    ];

    const isValidOrigin = origin && (allowedPatterns.some(pattern => pattern.test(origin)) || origin === 'http://localhost:3001');
    const isValidReferer = referer && (allowedPatterns.some(pattern => pattern.test(referer)) || referer.startsWith('http://localhost:3001'));

    if (!isValidOrigin && !isValidReferer) {
      console.warn(`🛡️ CSRF Block: Request denied from origin: ${origin || 'Unknown'}`);
      return res.status(403).json({ message: "Invalid Origin / Mismatched CSRF verification" });
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

    // FIX 4: Backfill NULL approval_status and employee_status so API returns real values
    await pool.query(`
      UPDATE jobs SET approval_status = 'pending_approval'
      WHERE approval_status IS NULL AND source = 'customer';

      UPDATE jobs SET approval_status = 'approved'
      WHERE approval_status IS NULL AND source != 'customer';

      UPDATE jobs SET employee_status = 'assigned'
      WHERE employee_status IS NULL AND status NOT IN ('completed', 'cancelled');
    `).catch(e => console.warn('⚠️ NULL backfill skipped:', e.message));

    // Step 2: Drop old constraint
    await pool.query(`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check`);

    // Step 3: Add new flexible constraint
    await pool.query(`
      ALTER TABLE jobs ADD CONSTRAINT jobs_status_check 
      CHECK (status IN ('open', 'pending', 'in_progress', 'active', 'completed', 'closed', 'cancelled'))
    `);

    console.log('✅ Database constraints fixed');

    // Step 4: Setup Periodic Refresh Token Cleanup (Every 24 hours)
    setInterval(async () => {
      try {
        const cleanupResult = await pool.query(`
          DELETE FROM refresh_tokens 
          WHERE expires_at < NOW() 
          OR (revoked = TRUE AND created_at < NOW() - INTERVAL '30 days')
        `);
        if (cleanupResult.rowCount > 0) {
          console.log(`🧹 Periodic Cleanup: Removed ${cleanupResult.rowCount} expired/revoked refresh tokens`);
        }
        // Also clean up customer_refresh_tokens table
        const crtCleanup = await pool.query(`
          DELETE FROM customer_refresh_tokens
          WHERE expires_at < NOW()
          OR (revoked = TRUE AND created_at < NOW() - INTERVAL '30 days')
        `).catch(() => ({ rowCount: 0 }));
        if (crtCleanup.rowCount > 0) {
          console.log(`🧹 Periodic Cleanup: Removed ${crtCleanup.rowCount} expired/revoked customer refresh tokens`);
        }
      } catch (cleanupErr) {
        console.error("❌ Periodic Cleanup Error:", cleanupErr.message);
      }
    }, 24 * 60 * 60 * 1000);
    console.log('🧹 Scheduled daily cleanup for refresh tokens');

  } catch (err) {
    console.warn('⚠️  Could not fix constraints:', err.message);
  }
}
/**
 * Run a SQL file statement-by-statement, skipping individual failures.
 * Splits on semicolons and strips single-line comments.
 */
async function runSqlStatements(sql, context = 'migration') {
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  let ok = 0;
  let skipped = 0;
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      ok++;
    } catch (err) {
      skipped++;
      console.warn(`[${context}] Skipped: ${err.message.split('\n')[0]}`);
    }
  }
  console.log(`[${context}] ${ok} applied, ${skipped} skipped`);
}

// ✅ Consolidated Database Initialization (Run once per deployment)
async function runDatabaseInitialization() {
  try {
    console.log('🏗️  Starting Database Initialization...');

    // 1. Fix constraints
    await fixDatabaseConstraints();

    // 2. Auto-migrate schema
    const { fixMaterialRequestsSchema, setupDocumentsTable } = require('./migrations/autoMigrate');
    await fixMaterialRequestsSchema();
    await setupDocumentsTable();

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

      -- Multi-device notification support
      CREATE TABLE IF NOT EXISTS user_devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fcm_token TEXT UNIQUE NOT NULL,
        device_type VARCHAR(50),
        last_seen TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);

      -- Feedback system for users to report bugs or suggest features
      CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        type VARCHAR(50) DEFAULT 'general',
        subject VARCHAR(255),
        message TEXT NOT NULL,
        page_url TEXT,
        status VARCHAR(50) DEFAULT 'new',
        admin_reply TEXT,
        replied_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      -- Add columns if they don't exist (for existing databases)
      ALTER TABLE feedback ADD COLUMN IF NOT EXISTS admin_reply TEXT;
      ALTER TABLE feedback ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP;

      CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
      CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);

      -- Expand notifications table for global broadcasts and metadata
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type VARCHAR(100) DEFAULT 'system';
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'normal';
      CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
    `);

    const { optimizeDatabase } = require('./scripts/optimizeDb');
    await optimizeDatabase();

    // 4. Customer Portal migration (additive — safe to re-run)
    // Section 6: Migration failure must NOT crash server
    try {
      const fs = require('fs');
      const path = require('path');
      const migrationSql = fs.readFileSync(
        path.join(__dirname, 'migrations', 'customer_portal_migration.sql'),
        'utf8'
      );
      await pool.query(migrationSql);
      console.log('✅ Customer Portal migration complete');
    } catch (cpErr) {
      // Section 6: Log error but continue — server stays up
      console.error('⚠️  Customer Portal migration failed:', cpErr.message);
      const errorLogger = require('./utils/errorLogger');
      errorLogger.log(cpErr, { context: 'migration.customer_portal' });
    }

    // 5. Workflow Enhancement migration (approval workflow, SLA, billing, etc.)
    // Run statement-by-statement so a single FK/column failure doesn't abort the rest
    try {
      const fs = require('fs');
      const path = require('path');
      const workflowSql = fs.readFileSync(
        path.join(__dirname, 'migrations', 'workflow_enhancement_migration.sql'),
        'utf8'
      );
      await runSqlStatements(workflowSql, 'migration.workflow_enhancement');
      console.log('✅ Workflow Enhancement migration complete');
    } catch (wfErr) {
      console.error('⚠️  Workflow Enhancement migration failed:', wfErr.message);
      const errorLogger = require('./utils/errorLogger');
      errorLogger.log(wfErr, { context: 'migration.workflow_enhancement' });
    }

    // 6. Hardening indexes (performance optimization)
    // Run statement-by-statement so a missing column doesn't abort all indexes
    try {
      const fs = require('fs');
      const path = require('path');
      const indexSql = fs.readFileSync(
        path.join(__dirname, 'migrations', 'hardening_indexes.sql'),
        'utf8'
      );
      await runSqlStatements(indexSql, 'migration.hardening_indexes');
      console.log('✅ Hardening indexes applied');
    } catch (idxErr) {
      console.error('⚠️  Hardening indexes failed:', idxErr.message);
      const errorLogger = require('./utils/errorLogger');
      errorLogger.log(idxErr, { context: 'migration.hardening_indexes' });
    }

    console.log('✅ Database Initialization & Optimization complete');
  } catch (err) {
    console.error('❌ Database Initialization failed:', err.message);
  }
}

// ✅ API Versioning (v1)
const v1Router = express.Router();
// NOTE: setTenantContext (RLS) is now applied inside authenticateToken
// so it always runs AFTER req.user is populated. No need for a global
// router-level middleware here.

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
v1Router.use("/material-requests", require("./routes/materialRequests"));
v1Router.use("/ai", require("./routes/ai.routes"));
v1Router.use("/messages", require("./routes/messages"));
v1Router.use("/dashboard", require("./routes/dashboard"));
v1Router.use("/reports", require("./routes/reports"));
v1Router.use("/settings", require("./routes/settings"));
v1Router.use("/location", require("./routes/location"));
v1Router.use("/subscription", require("./routes/subscription"));
v1Router.use("/hr", require("./routes/hr"));
v1Router.use("/admin", require("./routes/admin"));
v1Router.use("/documents", require("./routes/documents"));
v1Router.use("/webhook", require("./routes/webhook"));
v1Router.use("/feedback", require("./routes/feedback"));


// Mount v1 router
app.use("/api/v1", v1Router);
app.use("/api", v1Router); // Fallback for backward compatibility

// ✅ Customer Portal router (separate namespace — no tenant context middleware)
app.use("/api/customer", require("./routes/customer/index"));
app.use("/api/v1/customer", require("./routes/customer/index")); // v1 alias

// ✅ Customer Job Approval Workflow (Owner/HR portal)
app.use("/api/v1/customer-jobs", require("./routes/customerJobApproval"));
app.use("/api/customer-jobs", require("./routes/customerJobApproval")); // alias




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
  Sentry.setupExpressErrorHandler(app);
}

app.use((err, req, res, next) => {
  // Ensure CORS headers are present even on error responses
  const origin = req.headers.origin;
  const allowedOrigins = ['https://www.prozync.in', 'https://prozync.in', 'http://localhost:3000', 'https://client.prozync.in', 'http://localhost:3001'];
  if (origin && (allowedOrigins.includes(origin) || origin.match(/\.vercel\.app$/))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Handle CSRF errors specifically
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ message: "Invalid CSRF token. Please refresh the page." });
  }

  logger.error("Global API Route Error", err, { path: req.path, method: req.method });

  res.status(err.status || 500).json({
    message: err.message || "An internal server error occurred.",
    error: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// ✅ Catch uncaught exceptions to prevent silent process death
process.on("uncaughtException", (err) => {
  logger.error("🔥 UNCAUGHT EXCEPTION - Process Terminating", err);
  // Give Sentry 2s to flush then die
  setTimeout(() => process.exit(1), 2000);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("🔥 UNHANDLED REJECTION Detected", reason instanceof Error ? reason : new Error(String(reason)), { promiseType: String(promise) });
});

const cluster = require('cluster');
const totalCPUs = require('os').cpus().length;
// Cap workers to prevent OOM on Render's 512MB RAM limit
// We recommend 2 workers for 512MB, 4 for 1GB.
const WORKER_COUNT = process.env.WEB_CONCURRENCY || Math.min(totalCPUs, 2);

if (cluster.isPrimary && process.env.NODE_ENV === 'production') {

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
      const env = i === 0 ? { IS_PRIMARY_WORKER: 'true' } : {};
      cluster.fork(env);
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

    // Only run background workers on the designated primary worker (set via IS_PRIMARY_WORKER env)
    if (process.env.IS_PRIMARY_WORKER === 'true') {
      console.log("🛠️ Starting background processors and workers on primary worker...");

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

      // 🔔 Smart Notification Service: Migrated to Node-Cron 
      try {
        const { startSmartNotificationProcessor } = require('./jobs/smartNotificationProcessor');
        startSmartNotificationProcessor();
      } catch (err) {
        console.error('❌ Failed to start smart notification CRON processor:', err.message);
      }

      // 🏓 Render Keep-Alive Pinger: Prevent cold starts by pinging /api/health every 10 min
      try {
        const { startKeepAlivePinger } = require('./jobs/keepAlivePinger');
        startKeepAlivePinger();
      } catch (err) {
        console.error('❌ Failed to start keep-alive pinger:', err.message);
      }

      // 📍 Geofence Service: Check employee arrival every 12 seconds
      try {
        const geofenceService = require('./services/geofenceService');
        geofenceService.start();
      } catch (err) {
        console.error('❌ Failed to start geofence service:', err.message);
      }

      // 📋 SLA Service: Check SLA breaches every 2 minutes
      // Section 5: Only runs on primary worker — no duplicate background jobs
      try {
        const slaService = require('./services/slaService');
        slaService.start();
      } catch (err) {
        console.error('❌ Failed to start SLA service:', err.message);
      }

      // 🗑️ Error Log Retention: Purge old error logs daily
      // Section 9: Centralized error logging with retention
      try {
        const errorLogger = require('./utils/errorLogger');
        // Run once on startup, then daily
        errorLogger.purgeOldErrors();
        setInterval(() => errorLogger.purgeOldErrors(), 24 * 60 * 60 * 1000);
        console.log('🗑️  Error log retention scheduled');
      } catch (err) {
        console.error('❌ Failed to start error log retention:', err.message);
      }
    }
  });
}

module.exports = app;
