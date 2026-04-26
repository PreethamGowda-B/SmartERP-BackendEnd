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
/**/**
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
      console.warn('[' + context + '] Skipped: ' + err.message.split('\n')[0]);
    }
  }
  console.log('[' + context + '] ' + ok + ' applied, ' + skipped + ' skipped');
}

