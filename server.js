const dns = require("dns");
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

require("dotenv").config();
try {
  const outboundBandwidth = require('./utils/outboundBandwidth');
  // Payload telemetry is deliberately opt-in and never installs in production.
  // It is intended for an approved staging investigation only.
  if (outboundBandwidth.outboundBandwidthMonitoringEnabled()) {
    outboundBandwidth.installOutboundBandwidthMonitoring();
  }
} catch { try { console.warn('[outbound-bandwidth] instrumentation unavailable; continuing without measurements'); } catch { /* monitoring is optional */ } }
const { shouldStartBackgroundWorkers } = require('./utils/backgroundWorkerPolicy');
const logger = require("./utils/logger");
const Sentry = require("@sentry/node");
let nodeProfilingIntegration = null;
try {
  nodeProfilingIntegration = require("@sentry/profiling-node").nodeProfilingIntegration;
} catch (profErr) {
  if (typeof logger?.warn === "function") {
    logger.warn("Sentry profiling native binary unavailable for this architecture/runtime; continuing without CPU profiling", { error: profErr.message });
  }
}

// ✅ Initialize Sentry BEFORE anything else
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [
      ...(typeof nodeProfilingIntegration === "function" ? [nodeProfilingIntegration()] : []),
    ],
    tracesSampleRate: 0.1,
    profilesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
        delete event.request.headers['set-cookie'];
      }
      return event;
    },
  });

  logger.info("Sentry Observability initialized");
}

const express = require("express");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const { pool } = require("./db"); // ✅ Make sure db.js exports { pool }
const { storage } = require("./middleware/als"); // ✅ ALS — needed for global RLS initializer

const app = express();

// ✅ Global ALS initializer — MUST be the very first middleware.
// Ensures every HTTP request enters the ALS context so pool.query() never
// receives an undefined store (which would be treated as no-context = fail-closed).
// Auth routes opt-in to bypassRls: true via their own router-level middleware.
app.use((req, res, next) => {
  const suppliedId = req.get("x-request-id");
  const requestId = suppliedId && /^[A-Za-z0-9._:-]{1,100}$/.test(suppliedId)
    ? suppliedId
    : randomUUID();
  const startedAt = performance.now();
  let completed = false;
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const logCompletion = (outcome) => {
    if (completed) return;
    completed = true;
    const durationMs = performance.now() - startedAt;
    const slowThreshold = Number(process.env.REQUEST_TRACE_THRESHOLD_MS || 2000);
    const sanitizedPath = String(req.originalUrl || req.url).split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id");
    if (durationMs >= slowThreshold) {
      logger.warn("Slow HTTP request detected", {
        requestId,
        method: req.method,
        path: sanitizedPath,
        status: res.statusCode,
        outcome,
        durationMs: Number(durationMs.toFixed(2)),
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      });
    } else if (logger.isDebugEnabled()) {
      logger.debug("HTTP request completed", {
        requestId,
        method: req.method,
        path: sanitizedPath,
        status: res.statusCode,
        outcome,
        durationMs: Number(durationMs.toFixed(2)),
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      });
    }
  };
  res.once("finish", () => logCompletion("completed"));
  res.once("close", () => {
    if (!res.writableFinished) logCompletion("aborted");
  });

  storage.run({ isWebRequest: true, bypassRls: false, requestId }, next);
});

// ✅ Sentry Request Handling is now automatic in SDK v8+
// Just ensure Sentry.init() is called before any other code (done on line 7)

// ✅ CORS configuration — MUST be before rate limiters and other security headers
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    const cleanOrigin = origin.toLowerCase().trim();

    const allowedOrigins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://smart-erp-front-end.vercel.app",
      "https://www.prozync.in",
      "https://prozync.in",
      "https://smarterp.prozync.in",
      "https://customer.prozync.in",
      "https://superadmin.prozync.in",
      "https://api.prozync.in",
      "https://client.prozync.in",
    ];

    const configuredOrigins = [
      process.env.FRONTEND_ORIGIN,
      process.env.CUSTOMER_PORTAL_ORIGIN,
      process.env.SUPERADMIN_FRONTEND_ORIGIN,
    ].filter(Boolean).map(o => o.toLowerCase().trim());

    // Only allow specific authorized origins, *.prozync.in subdomains, or exact SmartERP vercel deployments
    const isAllowedVercelPreview = /^https:\/\/smart-erp-front-end(-[a-z0-9-]+)?\.vercel\.app$/.test(cleanOrigin);

    if (
      allowedOrigins.includes(cleanOrigin) ||
      configuredOrigins.includes(cleanOrigin) ||
      cleanOrigin.endsWith(".prozync.in") ||
      isAllowedVercelPreview
    ) {
      return callback(null, true);
    }

    console.warn("🚫 Blocked CORS request from:", origin);
    // Pass an error so the cors package still sets the response headers
    // (using `false` results in a headerless response which the browser reports as CORS failure)
    callback(new Error(`CORS: Origin not allowed: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-CSRF-Token",
    "X-Requested-With",
    "Accept",
    "sentry-trace",
    "baggage",
    "X-Request-Id",
    "Cache-Control",
    "Pragma",
    "Origin",
    "Idempotency-Key"
  ],
  exposedHeaders: ["Set-Cookie", "x-rtb-fingerprint-id", "request-id", "X-Request-Id"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Authenticated portal data must never be served from a browser, proxy, or CDN
// cache. A cached pre-update empty list can otherwise replace the live page
// state until the user reloads.
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// ✅ Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://www.prozync.in", "https://prozync.in"],
      connectSrc: [
        "'self'",
        "https://api.prozync.in",
        "https://www.prozync.in",
        "https://prozync.in",
        "https://*.firebaseio.com",
        "https://*.googleapis.com",
      ],
      imgSrc: ["'self'", "data:", "https:", "https://res.cloudinary.com"],
      mediaSrc: ["'self'", "data:", "blob:", "https:", "https://res.cloudinary.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
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

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many token refresh requests, please try again later." },
});

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);
app.use("/api/auth/refresh", refreshLimiter);
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

// ✅ Health check routes (mounted before rate limiters & v1Router for maximum speed & unthrottled uptime monitoring)
const healthHandler = async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      storage.run({ bypassRls: true }, async () => {
        try {
          const r = await pool.query("SELECT NOW()");
          resolve(r);
        } catch (e) {
          reject(e);
        }
      });
    });
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
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);
app.get("/api/v1/health", healthHandler);

// ✅ Lightweight in-memory ping routes for Render keep-alive pinger (avoids DB connection acquisition)
const pingHandler = (_req, res) => res.status(200).json({ status: "ok", timestamp: Date.now() });
app.get("/ping", pingHandler);
app.get("/api/ping", pingHandler);
app.get("/api/v1/ping", pingHandler);

// ✅ Info & Root routes
app.get("/api", (req, res) => res.json({ status: "ok" }));
app.get("/", (req, res) => res.status(200).json({ status: "ok" }));

// General API rate limiter — protects all other routes (300 req/15min per IP)
const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
  skip: (req) => {
    // Skip for already-limited auth & health routes
    return (
      req.path.startsWith('/api/auth/') ||
      req.path.startsWith('/api/v1/auth/') ||
      req.path.includes('/health')
    );
  }
});
// General API rate limiter — skip OPTIONS (preflight) so CORS headers are not stripped
app.use("/api", (req, _res, next) => {
  if (req.method === 'OPTIONS') return next();
  return generalApiLimiter(req, _res, next);
});

// ✅ Security Telemetry & Route Enumeration Detection (SmartERP Defensive Security AI)
const { securityTelemetryMiddleware } = require("./middleware/securityTelemetry");
app.use(securityTelemetryMiddleware);

// ✅ Trust proxy (required for HTTPS cookies on Render)
app.set("trust proxy", 1);

// ✅ Common middlewares
app.use(cookieParser());
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    // Razorpay signs the exact request bytes. Retain those bytes only on the
    // signed callback route; keeping a decoded duplicate for every API body
    // doubles peak memory for uploads and unnecessarily extends the lifetime
    // of sensitive request content.
    const requestPath = String(req.originalUrl || req.url || '').split('?')[0];
    if (
      requestPath === '/api/webhook/razorpay' ||
      requestPath === '/api/v1/webhook/razorpay' ||
      requestPath === '/webhooks/whatsapp' ||
      requestPath === '/api/webhooks/whatsapp' ||
      requestPath === '/api/v1/webhooks/whatsapp'
    ) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
      '/api/webhook', '/api/v1/webhook',
      '/webhooks/whatsapp', '/api/webhooks/whatsapp', '/api/v1/webhooks/whatsapp'
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
      /^https:\/\/smart-erp-front-end(-[a-z0-9-]+)?\.vercel\.app$/,
      /^https:\/\/smart-erp-front(-[a-z0-9]+)?(-[a-z0-9-]+)?\.vercel\.app$/,
      /^https:\/\/smart-erp-front-[a-z0-9]+-thepreethu01-9119s-projects\.vercel\.app$/,
      /^https:\/\/www\.prozync\.in$/,
      /^https:\/\/prozync\.in$/,
      /^https:\/\/smarterp\.prozync\.in$/,
      /^https:\/\/customer\.prozync\.in$/,
      /^https:\/\/superadmin\.prozync\.in$/,
      /^https:\/\/api\.prozync\.in$/,
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

// NOTE: /uploads is NOT served statically. All file access goes through
// authenticated routes in routes/documents.js

// Fix database constraints on startup
async function fixDatabaseConstraints() {
  let client;
  try {
    console.log('🔧 Fixing database constraints...');
    client = await pool.connect();
    await client.query('SET ROLE postgres').catch(() => {});

    // Step 1: Update any existing jobs with invalid status to 'open'
    const updateResult = await client.query(`
      UPDATE jobs
      SET status = 'open'
      WHERE status NOT IN ('open', 'pending', 'in_progress', 'active', 'completed', 'closed', 'cancelled')
    `);
    if (updateResult.rowCount > 0) {
      console.log(`✅ Updated ${updateResult.rowCount} jobs with invalid status`);
    }

    // FIX 4: Backfill NULL approval_status and employee_status so API returns real values
    await client.query(`
      UPDATE jobs SET approval_status = 'pending_approval'
      WHERE approval_status IS NULL AND source = 'customer';

      UPDATE jobs SET approval_status = 'approved'
      WHERE approval_status IS NULL AND (source IS NULL OR source != 'customer');

      UPDATE jobs SET employee_status = 'assigned'
      WHERE employee_status IS NULL AND status NOT IN ('completed', 'cancelled');
    `).catch(() => {});

    // C1 FIX: Enforce NOT NULL + DEFAULT on critical state columns
    await client.query(`
      ALTER TABLE jobs ALTER COLUMN approval_status SET DEFAULT 'pending_approval';
      ALTER TABLE jobs ALTER COLUMN employee_status SET DEFAULT 'assigned';
    `).catch(() => {});

    await client.query(`ALTER TABLE jobs ALTER COLUMN approval_status SET NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE jobs ALTER COLUMN employee_status SET NOT NULL`).catch(() => {});

    // C3 FIX: Ensure notifications.company_id is UUID
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'notifications'
            AND column_name = 'company_id'
            AND data_type = 'integer'
        ) THEN
          ALTER TABLE notifications ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid;
        END IF;
      END $$;
    `).catch(() => {});

    // Medium FIX: Add composite index for unread message queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_job_messages_unread
      ON job_messages(job_id, sender_type, read_by_employee);
    `).catch(() => {});

    // C2 FIX: Migrate job_messages.company_id from TEXT to UUID
    await client.query(`
      ALTER TABLE job_messages ADD COLUMN IF NOT EXISTS company_id TEXT;
    `).catch(() => {});
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'job_messages'
            AND column_name = 'company_id'
            AND data_type = 'text'
        ) THEN
          UPDATE job_messages SET company_id = NULL
            WHERE company_id IS NOT NULL
              AND company_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
          ALTER TABLE job_messages
            ALTER COLUMN company_id TYPE UUID USING company_id::uuid;
        END IF;
      END $$;
    `).catch(() => {});

    // Ensure refresh_tokens and customer_refresh_tokens have updated_at, last_activity_at, revoked_at columns
    await client.query(`
      ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
      ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE customer_refresh_tokens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE customer_refresh_tokens ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
      ALTER TABLE customer_refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP WITH TIME ZONE;
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_last_activity ON refresh_tokens(user_id, last_activity_at);
      CREATE INDEX IF NOT EXISTS idx_crt_last_activity ON customer_refresh_tokens(customer_id, last_activity_at);
    `).catch(() => {});

    // Ensure jobs and invoices have all joined columns expected by routes/jobs.js
    await client.query(`
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assigned_employee_id UUID;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_by UUID;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source VARCHAR(50);
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_latest BOOLEAN DEFAULT TRUE;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS version_number INTEGER DEFAULT 1;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS edited_count INTEGER DEFAULT 0;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS downloaded_at TIMESTAMPTZ;
    `).catch(() => {});

    // Ensure production_packing_records table exists with RLS and permissions so production orders never 503
    await client.query(`
      CREATE TABLE IF NOT EXISTS production_packing_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id TEXT NOT NULL,
        order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
        inspection_id UUID NOT NULL REFERENCES production_inspections(id) ON DELETE RESTRICT,
        quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
        package_count INTEGER NOT NULL DEFAULT 1 CHECK (package_count > 0),
        package_type VARCHAR(100),
        status VARCHAR(32) NOT NULL DEFAULT 'packing'
          CHECK (status IN ('packing','packed','ready_for_dispatch')),
        notes TEXT,
        recorded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        recorded_by_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE production_dispatches ADD COLUMN IF NOT EXISTS packing_record_id UUID;
      ALTER TABLE production_packing_records ENABLE ROW LEVEL SECURITY;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE tablename = 'production_packing_records' AND policyname = 'production_packing_records_tenant_policy'
        ) THEN
          CREATE POLICY production_packing_records_tenant_policy ON production_packing_records
            USING (company_id::text = current_setting('app.current_company_id', true));
        END IF;
      END $$;
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smarterp_app') THEN
          GRANT SELECT, INSERT, UPDATE ON TABLE production_packing_records TO smarterp_app;
        END IF;
      END $$;
    `).catch(() => {});

    logger.debug('Database constraints verified and fixed');

  } catch (err) {
    logger.warn('Could not fix database constraints (non-fatal)', { error: err.message });
  } finally {
    if (client) client.release();
  }
}

async function cleanupExpiredRefreshTokens() {
  try {
    const cleanupResult = await pool.query(`
      DELETE FROM refresh_tokens
      WHERE expires_at < NOW()
      OR (revoked = TRUE AND created_at < NOW() - INTERVAL '30 days')
    `);
    if (cleanupResult.rowCount > 0) {
      console.log(`🧹 Periodic Cleanup: Removed ${cleanupResult.rowCount} expired/revoked refresh tokens`);
    }
    const customerResult = await pool.query(`
      DELETE FROM customer_refresh_tokens
      WHERE expires_at < NOW()
      OR (revoked = TRUE AND created_at < NOW() - INTERVAL '30 days')
    `).catch(() => ({ rowCount: 0 }));
    if (customerResult.rowCount > 0) {
      console.log(`🧹 Periodic Cleanup: Removed ${customerResult.rowCount} expired/revoked customer refresh tokens`);
    }
  } catch (error) {
    console.error('❌ Periodic Cleanup Error:', error.message);
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
    logger.info('Starting Database Initialization and Schema Verification...');

    // 1. Fix constraints
    await fixDatabaseConstraints();

    // 2. Auto-migrate schema
    const { fixMaterialRequestsSchema, setupDocumentsTable } = require('./migrations/autoMigrate');
    await fixMaterialRequestsSchema();
    await setupDocumentsTable();
    const { runProductionDispatchMigration } = require('./migrations/runProductionDispatch');
    const productionMigrations = await runProductionDispatchMigration();
    for (const migration of productionMigrations) {
      console.log(`✅ ${migration.migrationId}: ${migration.status}`);
    }

    // 2b. Ensure all CNC tables & SLA columns exist
    let initClient;
    try {
      initClient = await pool.connect();
      await initClient.query('SET ROLE postgres').catch(() => {});
      const { ensureWorkRequestsSchemaOwner } = require('./utils/workRequestsTableInitializer');
      await ensureWorkRequestsSchemaOwner(initClient);

      await initClient.query(`
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_target_hours NUMERIC DEFAULT 4.0;
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_status VARCHAR(50) DEFAULT 'on_track';
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_response_minutes INTEGER;
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_resolution_minutes INTEGER;
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS machine_id TEXT;
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS controller_type VARCHAR(100);
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS alarm_code VARCHAR(100);
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS service_type VARCHAR(50) DEFAULT 'breakdown';

        CREATE TABLE IF NOT EXISTS warranty_claims (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id TEXT NOT NULL,
          claim_number VARCHAR(100),
          machine_id TEXT,
          job_id TEXT,
          spare_part_name VARCHAR(255),
          part_name VARCHAR(255),
          serial_number VARCHAR(100),
          supplier_name VARCHAR(255),
          vendor_name VARCHAR(255),
          failure_reason TEXT,
          claim_type VARCHAR(50) DEFAULT 'spare_part',
          status VARCHAR(50) DEFAULT 'submitted',
          claim_amount NUMERIC(10,2) DEFAULT 0.00,
          supplier_credit_amount NUMERIC(10,2) DEFAULT 0.00,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS cnc_vendors (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id TEXT NOT NULL,
          vendor_name VARCHAR(255) NOT NULL,
          contact_person VARCHAR(255),
          phone VARCHAR(50),
          email VARCHAR(255),
          rating NUMERIC(3,1) DEFAULT 4.8,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS purchase_orders (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id TEXT NOT NULL,
          po_number VARCHAR(100) NOT NULL,
          vendor_name VARCHAR(255) NOT NULL,
          job_id TEXT,
          parts_description TEXT NOT NULL,
          total_cost NUMERIC(12,2) DEFAULT 0.00,
          status VARCHAR(50) DEFAULT 'issued',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS engineer_routes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id TEXT NOT NULL,
          engineer_id TEXT NOT NULL,
          engineer_name VARCHAR(255) NOT NULL,
          route_date DATE DEFAULT CURRENT_DATE,
          stops_count INT DEFAULT 1,
          total_km NUMERIC(6,1) DEFAULT 0.0,
          optimized_minutes INT DEFAULT 0,
          status VARCHAR(50) DEFAULT 'active',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS automation_rules (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id TEXT NOT NULL,
          rule_name VARCHAR(255) NOT NULL,
          trigger_event VARCHAR(100) NOT NULL,
          action_type VARCHAR(100) NOT NULL,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS ai_action_audit_trail (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id TEXT NOT NULL,
          user_id TEXT,
          user_name VARCHAR(255),
          prompt TEXT,
          ai_interpretation TEXT,
          workflow_type VARCHAR(100),
          execution_level INT DEFAULT 1,
          approval_status VARCHAR(50) DEFAULT 'executed',
          result_summary TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
      `).catch(() => {});

      // 3. OTP setup and Core optimization
      await initClient.query(`
        CREATE TABLE IF NOT EXISTS email_otps (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          otp_code VARCHAR(64) NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          used BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps(email);

        ALTER TABLE email_otps ALTER COLUMN otp_code TYPE VARCHAR(64);
        ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_type TEXT;
        ALTER TABLE activities ADD COLUMN IF NOT EXISTS details JSONB;
        ALTER TABLE activities ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

        CREATE TABLE IF NOT EXISTS user_devices (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          fcm_token TEXT UNIQUE NOT NULL,
          device_type VARCHAR(50),
          last_seen TIMESTAMP DEFAULT NOW(),
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);

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

        ALTER TABLE feedback ADD COLUMN IF NOT EXISTS admin_reply TEXT;
        ALTER TABLE feedback ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP;

        CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
        CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);

        ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id UUID;
        ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type VARCHAR(100) DEFAULT 'system';
        ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'normal';
        CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);

        ALTER TABLE invoices ADD COLUMN IF NOT EXISTS edited_count INTEGER DEFAULT 0;

        CREATE TABLE IF NOT EXISTS job_action_requests (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          employee_id UUID REFERENCES users(id) ON DELETE SET NULL,
          employee_name VARCHAR(255),
          module VARCHAR(100),
          action_type VARCHAR(100) NOT NULL,
          urgency VARCHAR(50) DEFAULT 'normal',
          notes TEXT,
          evidence_urls JSONB DEFAULT '[]',
          payload JSONB DEFAULT '{}',
          status VARCHAR(50) DEFAULT 'pending',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMP WITH TIME ZONE,
          review_notes TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_jar_job_id ON job_action_requests(job_id);
        CREATE INDEX IF NOT EXISTS idx_jar_company_id ON job_action_requests(company_id);
        CREATE INDEX IF NOT EXISTS idx_jar_status ON job_action_requests(status);
      `);
    } catch (schemaErr) {
      logger.error("Fatal error applying CNC/SLA/WorkRequests schema in master initialization", schemaErr);
      throw schemaErr;
    } finally {
      if (initClient) {
        await initClient.query("RESET ROLE").catch(() => {});
        initClient.release();
      }
    }

    try {
      const { optimizeDatabase } = require('./scripts/optimizeDb');
      await optimizeDatabase();
    } catch (e) {
      console.warn('⚠️ optimizeDb skipped (script not available in this environment)');
    }

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

    // 5. Workflow & Schema migrations (idempotent — skip replay if already applied)
    try {
      const fs = require('fs');
      const path = require('path');
      const checkResult = await pool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'company_settings' LIMIT 1"
      ).catch(() => ({ rows: [] }));

      if (checkResult.rows.length === 0) {
        const workflowSql = fs.readFileSync(
          path.join(__dirname, 'migrations', 'workflow_enhancement_migration.sql'),
          'utf8'
        );
        await runSqlStatements(workflowSql, 'migration.workflow_enhancement');
        console.log('✅ Workflow Enhancement migration complete');

        const hrMasterSql = fs.readFileSync(
          path.join(__dirname, 'migrations', 'hr_master_backbone_schema.sql'),
          'utf8'
        );
        await runSqlStatements(hrMasterSql, 'migration.hr_master_backbone');
        const msgIdxSql = fs.readFileSync(
          path.join(__dirname, 'migrations', 'messaging_performance_indexes.sql'),
          'utf8'
        );
        await runSqlStatements(msgIdxSql, 'migration.messaging_performance_indexes');

        const commBackboneSql = fs.readFileSync(
          path.join(__dirname, 'migrations', 'enterprise_communication_backbone.sql'),
          'utf8'
        );
        await runSqlStatements(commBackboneSql, 'migration.enterprise_communication_backbone');
        console.log('✅ Enterprise Communication Backbone database schema applied');

        const indexSql = fs.readFileSync(
          path.join(__dirname, 'migrations', 'hardening_indexes.sql'),
          'utf8'
        );
        await runSqlStatements(indexSql, 'migration.hardening_indexes');
        console.log('✅ Hardening indexes applied');
      } else {
        console.log('⚡ Workflow & communication backbone migrations already applied — skipping replay');
      }
    } catch (wfErr) {
      console.error('⚠️  Workflow/HR/Messaging migration check failed:', wfErr.message);
      const errorLogger = require('./utils/errorLogger');
      errorLogger.log(wfErr, { context: 'migration.workflow_enhancement' });
    }

    console.log('✅ Database Initialization & Optimization complete');

    // 7. One-time data fix: customer jobs that were accepted/completed but still show pending_approval
    try {
      const fixResult = await pool.query(`
        UPDATE jobs
        SET approval_status = 'approved',
            approved_at     = COALESCE(accepted_at, started_at, NOW())
        WHERE source = 'customer'
          AND approval_status = 'pending_approval'
          AND (
            status IN ('completed', 'in_progress', 'active')
            OR employee_status IN ('accepted', 'completed', 'arrived')
          )
        RETURNING id
      `);
      if (fixResult.rowCount > 0) {
        console.log(`✅ Fixed ${fixResult.rowCount} stuck customer job(s) — approval_status updated to approved`);
      }
    } catch (fixErr) {
      console.warn('⚠️  Customer job approval_status fix failed (non-fatal):', fixErr.message);
    }

    // 8. One-time data fix: jobs with progress=100 that are still marked in_progress
    try {
      const progressFixResult = await pool.query(`
        UPDATE jobs
        SET status          = 'completed',
            employee_status = 'completed',
            completed_at    = COALESCE(completed_at, NOW())
        WHERE progress = 100
          AND status NOT IN ('completed', 'cancelled')
        RETURNING id, title
      `);
      if (progressFixResult.rowCount > 0) {
        console.log(`✅ Fixed ${progressFixResult.rowCount} job(s) with 100% progress stuck in non-completed status`);
      }
    } catch (fixErr) {
      console.warn('⚠️  Progress=100 status fix failed (non-fatal):', fixErr.message);
    }

    // 9. Seed platform Super Admin account (admin@prozync.in)
    try {
      const seedScriptPath = path.join(__dirname, 'scripts', 'seedSuperAdmin.js');
      const { seedSuperAdmin } = require(seedScriptPath);
      await seedSuperAdmin();
    } catch (saErr) {
      console.warn('⚠️  Super Admin seed failed (non-fatal):', saErr.message);
    }

    // 10. Run local document storage to Cloudinary migration if local files exist
    try {
      const migrateDocsPath = path.join(__dirname, 'scripts', 'migrate_documents_to_cloud.js');
      const migrateDocumentsToCloud = require(migrateDocsPath);
      await migrateDocumentsToCloud();
    } catch (docMigErr) {
      console.warn('⚠️  Document cloud migration skipped or failed (non-fatal):', docMigErr.message);
    }
  } catch (err) {
    console.error('❌ Database Initialization failed:', err.message);
    throw err;
  }
}

// ✅ Create API v1 Router
const v1Router = express.Router();

// ✅ Platform Maintenance Mode Middleware with single-flight promise deduplication and in-memory caching
let maintenanceSettingCache = null;
let maintenanceSettingExpiresAt = 0;
let maintenanceSettingInFlight = null;

async function resolveMaintenanceSetting() {
  const now = Date.now();
  if (maintenanceSettingCache !== null && maintenanceSettingExpiresAt > now) {
    return maintenanceSettingCache;
  }
  if (maintenanceSettingInFlight) {
    return maintenanceSettingInFlight;
  }

  maintenanceSettingInFlight = (async () => {
    try {
      const r = await pool.query(
        "SELECT value FROM system_settings WHERE key = 'maintenance_mode'"
      );
      const setting = r.rows[0]?.value || null;
      maintenanceSettingCache = setting;
      maintenanceSettingExpiresAt = Date.now() + 10000; // 10s in-memory TTL
      return setting;
    } catch (err) {
      // Fail open: retain previous setting or null briefly (2s) so failures don't hammer DB
      maintenanceSettingExpiresAt = Date.now() + 2000;
      return maintenanceSettingCache || null;
    } finally {
      maintenanceSettingInFlight = null;
    }
  })();

  return maintenanceSettingInFlight;
}

v1Router.use(async (req, res, next) => {
  // Always bypass maintenance mode for Super Admin management API routes
  if (req.path.startsWith('/admin')) {
    return next();
  }

  try {
    const setting = await resolveMaintenanceSetting();

    if (!setting || setting.mode === 'disabled') {
      return next();
    }

    if (setting.mode === 'emergency' || setting.mode === 'enabled') {
      return res.status(503).json({
        error: 'Service Unavailable',
        message: setting.message || 'SmartERP platform is currently undergoing maintenance. Please try again shortly.',
        maintenance_mode: setting.mode,
        retry_after_seconds: 300
      });
    }

    if (setting.mode === 'read_only' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(423).json({
        error: 'Locked',
        message: setting.message || 'Platform is currently in read-only mode during system maintenance. Writes are disabled.',
        maintenance_mode: setting.mode
      });
    }
  } catch (err) {
    // Fail open if maintenance check fails so platform stays accessible
  }

  next();
});

v1Router.use("/auth", require("./routes/auth"));
v1Router.use("/users", require("./routes/users"));
v1Router.use("/jobs", require("./routes/jobs"));
v1Router.use("/jobs", require("./routes/proofOfWork"));
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
v1Router.use("/ai", require("./routes/aiPersistence.routes"));
v1Router.use("/messages", require("./routes/messages"));
v1Router.use("/dashboard", require("./routes/dashboard"));
v1Router.use("/reports", require("./routes/reports"));
v1Router.use("/settings", require("./routes/settings"));
v1Router.use("/account", require("./routes/account"));
v1Router.use("/location", require("./routes/location"));
v1Router.use("/subscription", require("./routes/subscription"));
v1Router.use("/hr", require("./routes/hr"));
v1Router.use("/admin", require("./routes/admin"));
v1Router.use("/documents", require("./routes/documents"));
v1Router.use("/webhook", require("./routes/webhook"));
v1Router.use("/feedback", require("./routes/feedback"));
v1Router.use("/support", require("./routes/support"));
v1Router.use("/gst-reconciliation", require("./routes/gstReconciliation"));
v1Router.use("/inventory-forecast", require("./routes/inventoryForecast"));
v1Router.use("/ar-collections", require("./routes/arCollections"));
v1Router.use("/payroll-validation", require("./routes/payrollValidation"));
v1Router.use("/audit-logs", require("./routes/ai.routes"));
v1Router.use("/invoices", require("./routes/invoices"));
v1Router.use("/finance", require("./routes/finance"));
v1Router.use("/work-requests", require("./routes/workRequests"));
v1Router.use("/machines", require("./routes/machines"));
v1Router.use("/plants", require("./routes/plants"));
v1Router.use("/production", require("./routes/production"));
v1Router.use("/customer-manufacturing-requests", require("./routes/customerManufacturingRequests"));
v1Router.use("/quotations", require("./routes/quotations"));
v1Router.use("/remote-support", require("./routes/remoteSupport"));
v1Router.use("/customers", require("./routes/customers"));
v1Router.use("/command-center", require("./routes/commandCenter"));
v1Router.use("/sla", require("./routes/sla"));
v1Router.use("/warranty-claims", require("./routes/warrantyClaims"));
v1Router.use("/search", require("./routes/enterpriseSearch"));
v1Router.use("/customer-reports", require("./routes/customerReports"));
v1Router.use("/ai/copilot", require("./routes/businessCopilot"));
v1Router.use("/ai/predictive-maintenance", require("./routes/predictiveMaintenance"));
v1Router.use("/ai/auto-schedule", require("./routes/autoSchedule"));
v1Router.use("/automation-center", require("./routes/automationCenter"));
v1Router.use("/executive-bi", require("./routes/executiveBI"));
v1Router.use("/superadmin/health-metrics", require("./routes/superadminHealth"));
v1Router.use("/vendors", require("./routes/cncVendors"));
v1Router.use("/route-optimization", require("./routes/routeOptimization"));
v1Router.use("/saas", require("./routes/saasManagement"));
v1Router.use("/export", require("./routes/export"));


// ✅ Meta WhatsApp Business Cloud API Webhook routes
const whatsappRoutes = require("./routes/whatsapp");
app.use("/webhooks/whatsapp", whatsappRoutes);
app.use("/api/webhooks/whatsapp", whatsappRoutes);
v1Router.use("/webhooks/whatsapp", whatsappRoutes);

// Mount v1 router
app.use("/api/v1", v1Router);
app.use("/api", v1Router); // Fallback for backward compatibility

// ✅ Customer Portal router (separate namespace — no tenant context middleware)
app.use("/api/customer", require("./routes/customer/index"));
app.use("/api/v1/customer", require("./routes/customer/index")); // v1 alias

// ✅ Customer Job Approval Workflow (Owner/HR portal)
app.use("/api/v1/customer-jobs", require("./routes/customerJobApproval"));
app.use("/api/customer-jobs", require("./routes/customerJobApproval")); // alias

// ✅ Super Admin Defensive Security AI Center Routes (Protected by authenticateToken + authenticateSuperAdmin)
const securityRoutes = require("./routes/security");
app.use("/api/v1/superadmin/security", securityRoutes);
app.use("/api/superadmin/security", securityRoutes);

// ✅ Global Error Handler (MUST BE LAST)
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use((err, req, res, next) => {
  // Ensure CORS headers are present even on error responses.
  // Use the SAME allowedPatterns as the CSRF middleware — one canonical list.
  const origin = req.headers.origin;
  const allowedOrigins = [
    'https://www.prozync.in',
    'https://prozync.in',
    'https://smarterp.prozync.in',
    'https://customer.prozync.in',
    'https://superadmin.prozync.in',
    'https://api.prozync.in',
    'http://localhost:3000',
    'https://client.prozync.in',
    'http://localhost:3001'
  ];
  const allowedPatterns = [
    /^https:\/\/smart-erp-front-end(-[a-z0-9-]+)?\.vercel\.app$/,
    /^https:\/\/smart-erp-front(-[a-z0-9]+)?(-[a-z0-9-]+)?\.vercel\.app$/,
    /^https:\/\/smart-erp-front-[a-z0-9]+-thepreethu01-9119s-projects\.vercel\.app$/,
  ];
  const cleanOrigin = origin ? origin.toLowerCase().trim() : '';
  const isAllowedOrigin = cleanOrigin && (
    allowedOrigins.includes(cleanOrigin) ||
    cleanOrigin.endsWith('.prozync.in') ||
    allowedPatterns.some(p => p.test(cleanOrigin))
  );
  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token,X-Requested-With,Accept,Idempotency-Key');
  }

  // Handle CSRF errors specifically
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ message: "Invalid CSRF token. Please refresh the page." });
  }

  logger.error("Global API Route Error", err, { path: req.path, method: req.method });

  // Only echo err.message for deliberate errors (those with a .status set by route handlers).
  // For unexpected/unhandled errors, always return a generic message to avoid
  // leaking DB table names, column names, or query fragments to the client.
  res.status(err.status || 500).json({
    message: err.status ? (err.message || "An error occurred.") : "An internal server error occurred.",
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
const { createClusterLifecycle } = require('./utils/clusterLifecycle');
const totalCPUs = require('os').cpus().length;
// Cap workers to prevent OOM on Render's 512MB RAM limit
// We recommend 2 workers for 512MB, 4 for 1GB.
const WORKER_COUNT = process.env.WEB_CONCURRENCY || Math.min(totalCPUs, 2);

if (cluster.isPrimary && process.env.NODE_ENV === 'production') {

  logger.info('Master process running', { pid: process.pid });
  logger.info('Spawning cluster workers', { pid: process.pid, workerCount: WORKER_COUNT });

  const clusterLifecycle = createClusterLifecycle({ cluster, logger });
  // Install signal handlers before DB initialization so shutdown cannot race startup.
  clusterLifecycle.install();

  // Cross-worker IPC message forwarding for multi-worker cache invalidation
  cluster.on('message', (worker, message) => {
    if (message?.cmd === 'cache:invalidate:company_settings') {
      for (const id in cluster.workers) {
        if (cluster.workers[id] && cluster.workers[id].id !== worker.id) {
          try { cluster.workers[id].send(message); } catch (_) {}
        }
      }
    }
  });

  // Schema repairs, DDL, seed checks, and storage migrations do not belong on
  // the request-serving startup path. They create noisy deploy logs, delay the
  // health check, and can contend with live traffic. Run them deliberately via
  // a maintenance deploy by setting RUN_STARTUP_DB_MAINTENANCE=true.
  const runStartupDbMaintenance = process.env.RUN_STARTUP_DB_MAINTENANCE === 'true';
  (async () => {
    try {
      if (runStartupDbMaintenance) {
        await new Promise((resolve, reject) =>
          storage.run({ bypassRls: true }, async () => {
            try { await runDatabaseInitialization(); resolve(); }
            catch (err) { reject(err); }
          })
        );
      } else {
        logger.info('Skipping startup database maintenance; use RUN_STARTUP_DB_MAINTENANCE=true for a controlled maintenance deploy.');
      }
      // The parent only coordinates schema initialization. Release its idle
      // pool before forking workers so it does not consume session-pool slots.
      await pool.end();
      logger.debug('Master DB pool closed before worker startup');
    } catch (err) {
      logger.fatal('Master DB Init Error:', { error: err.message });
      // Do not serve a deployment whose required schema migration failed.
      process.exit(1);
      return;
    }
    clusterLifecycle.start(WORKER_COUNT);
  })();

} else {
  // Listen for cluster primary cache invalidation broadcasts
  process.on('message', (message) => {
    if (message?.cmd === 'cache:invalidate:company_settings' && message.companyId) {
      try {
        const { invalidateCompanySettings } = require('./services/companySettingsService');
        invalidateCompanySettings(message.companyId, true);
      } catch (_) {}
    }
  });

  // ✅ Start server
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, async () => {
    // Run background processors once per Render service instance. In production
    // cluster mode only the explicitly designated worker owns scheduled work;
    // development/non-cluster mode has one process and can run it locally.
    const shouldStartWorkers = shouldStartBackgroundWorkers({
      isClusterWorker: cluster.isWorker,
      isPrimaryWorker: process.env.IS_PRIMARY_WORKER,
      nodeEnv: process.env.NODE_ENV,
    });

    if (shouldStartWorkers) {
      backgroundWorkersStarted = true;
      try {
        const { validateEnvironmentVariables } = require('./utils/envValidator');
        const envAudit = validateEnvironmentVariables();
        if (!envAudit.isValid) {
          const failures = envAudit.variables.filter(v => !v.valid).map(v => `${v.key} (${v.reason})`).join(', ');
          logger.warn(`Environment configuration issues detected at startup: ${failures}`, { pid: process.pid });
        }
        const { printStartupDashboard } = require('./utils/startupDashboard');
        const redisClient = require('./utils/redis');
        await printStartupDashboard({
          port: PORT,
          processRole: cluster.isWorker ? 'primary-worker' : 'standalone-service',
          workerId: cluster.worker?.id || 1,
          isPrimaryWorker: true,
          pool,
          redisClient,
          backgroundWorkersStarted: true,
        });
      } catch (dashErr) {
        logger.warn('Failed to print startup dashboard:', { error: dashErr.message });
      }
    } else {
      logger.info('SmartERP cluster worker running', {
        pid: process.pid,
        port: PORT,
        workerId: cluster.worker?.id || 2,
        role: 'secondary-worker',
      });
    }

    if (!shouldStartWorkers && process.env.ENABLE_BACKGROUND_WORKERS === 'true') {
      logger.warn('ENABLE_BACKGROUND_WORKERS is ignored in non-primary cluster workers to prevent duplicate processors', { pid: process.pid });
    }

    if (shouldStartWorkers) {
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
        const { runWithPostgresAdvisoryLock } = require('./utils/scheduledTaskLock');
        // Run once on startup, then daily
        void runWithPostgresAdvisoryLock('error-log-retention', () => errorLogger.purgeOldErrors());
        errorLogRetentionTimer = setInterval(() => {
          void runWithPostgresAdvisoryLock('error-log-retention', () => errorLogger.purgeOldErrors());
        }, 24 * 60 * 60 * 1000);
        console.log('🗑️  Error log retention scheduled');
      } catch (err) {
        console.error('❌ Failed to start error log retention:', err.message);
      }

      try {
        const { runWithPostgresAdvisoryLock } = require('./utils/scheduledTaskLock');
        refreshTokenCleanupTimer = setInterval(() => {
          void runWithPostgresAdvisoryLock('refresh-token-cleanup', cleanupExpiredRefreshTokens);
        }, 24 * 60 * 60 * 1000);
        logger.info('Scheduled daily cleanup for refresh tokens', { pid: process.pid });
      } catch (err) {
        logger.error('Failed to start refresh token cleanup scheduler', { error: err.message });
      }
    }
  });
}

module.exports = app;

// ✅ Graceful shutdown — drain in-flight requests before closing DB pool
// This prevents connection errors on Render deploys and SIGTERM events.
let httpServer = null;
let errorLogRetentionTimer = null;
let refreshTokenCleanupTimer = null;
let backgroundWorkersStarted = false;

async function stopBackgroundProcessors() {
  const stops = [];
  for (const [file, method] of [
    ['./jobs/dailyAttendanceProcessor', 'stopDailyAttendanceProcessor'],
    ['./jobs/trialExpiryProcessor', 'stopTrialExpiryProcessor'],
    ['./jobs/smartNotificationProcessor', 'stopSmartNotificationProcessor'],
  ]) {
    try {
      const processor = require(file);
      processor[method]?.();
    } catch (error) {
      logger.warn('Background processor stop failed', { processor: file, error: error.message });
    }
  }
  try { require('./services/geofenceService').stop(); } catch (error) { logger.warn('Geofence shutdown failed', { error: error.message }); }
  try { require('./services/slaService').stop(); } catch (error) { logger.warn('SLA shutdown failed', { error: error.message }); }
  if (errorLogRetentionTimer) {
    clearInterval(errorLogRetentionTimer);
    errorLogRetentionTimer = null;
  }
  if (refreshTokenCleanupTimer) {
    clearInterval(refreshTokenCleanupTimer);
    refreshTokenCleanupTimer = null;
  }
  await Promise.allSettled(stops);
  try { await require('./utils/scheduledTaskLock').drainScheduledTaskLocks(); }
  catch (error) { logger.warn('Scheduled task drain failed', { error: error.message }); }
  if (backgroundWorkersStarted) {
    try { await require('./jobs/workers').closeBackgroundWorkers(); } catch (error) { logger.warn('Queue worker shutdown failed', { error: error.message }); }
    try { await require('./utils/queue').closeQueues(); } catch (error) { logger.warn('Queue shutdown failed', { error: error.message }); }
  }
}

function registerGracefulShutdown(server) {
  httpServer = server;
  require('./utils/workerShutdown').registerWorkerShutdown({
    processRef: process,
    getServer: () => httpServer,
    stopProcessors: stopBackgroundProcessors,
    closeMonitoring: () => require('./utils/outboundBandwidth').stopOutboundBandwidthMonitoring(),
    closeDatabase: async () => {
      const { pool: shutdownPool } = require('./db');
      await shutdownPool.end();
    },
    closeRedis: async () => {
      const redisPath = require.resolve('./utils/redis');
      if (require.cache[redisPath]) await require('./utils/redis').closeRedisConnections();
    },
    logger,
  });
}

// Every cluster worker, including secondaries, must drain cleanly.
const origListen = app.listen.bind(app);
app.listen = (...args) => {
  const server = origListen(...args);
  registerGracefulShutdown(server);
  return server;
};

// ✅ Authenticated document access — replaces the removed express.static('/uploads')
// Files are served only after verifying the requester's company ownership
const path = require("path");
const { authenticateToken: _authDoc } = require("./middleware/authMiddleware");
app.get("/uploads/documents/:filename", _authDoc, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // prevent path traversal
    const companyId = req.user.companyId;

    // Verify this file belongs to the requesting user's company
    const { pool: _pool } = require("./db");
    const check = await _pool.query(
      `SELECT id FROM employee_documents
       WHERE file_url LIKE $1 AND company_id::text = $2
       LIMIT 1`,
      [`%${filename}`, String(companyId)]
    );

    if (!check.rows.length) {
      return res.status(403).json({ message: "Access denied" });
    }

    const filePath = path.join(__dirname, "uploads", "documents", filename);
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error("File serve error:", err.message);
        res.status(404).json({ message: "File not found" });
      }
    });
  } catch (err) {
    console.error("Document serve error:", err.message);
    res.status(500).json({ message: "Could not retrieve file" });
  }
});
