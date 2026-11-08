const Sentry = require("@sentry/node");

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

function getActiveLogLevel() {
  const envLevel = (process.env.LOG_LEVEL || "").toLowerCase();
  if (LOG_LEVELS[envLevel]) return LOG_LEVELS[envLevel];
  if (process.env.DEBUG === "true" || process.env.DEBUG === "1") return LOG_LEVELS.debug;
  return process.env.NODE_ENV === "production" ? LOG_LEVELS.info : LOG_LEVELS.debug;
}

function isLevelEnabled(level) {
  const currentThreshold = getActiveLogLevel();
  const targetLevel = LOG_LEVELS[level] || LOG_LEVELS.info;
  return targetLevel >= currentThreshold;
}

function isDebugEnabled() {
  return isLevelEnabled("debug");
}

const SENSITIVE_KEY_PATTERN = /password|token|secret|authorization|cookie|service_account|credential|private_key/i;

function sanitizeValue(value, depth = 0) {
  if (depth > 5) return "[Max Depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Redact JWT-like or base64-like long tokens
    if (/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(value)) {
      return "[REDACTED_JWT]";
    }
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  const clean = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      clean[k] = "[REDACTED]";
    } else {
      clean[k] = sanitizeValue(v, depth + 1);
    }
  }
  return clean;
}

/**
 * 📝 Structured App Logger
 * In Production: Spits out parsable JSON (extremely fast/lightweight for Render log streams).
 * In Development: Readable emoji/colorized strings for debugging comfort.
 */
const logger = {
  isLevelEnabled,
  isDebugEnabled,
  sanitize: sanitizeValue,

  /**
   * Diagnostic low-level information (SQL queries, RLS timings, connection acquiring).
   * Hidden in production unless LOG_LEVEL=debug or DEBUG=true.
   */
  debug: (message, meta = {}) => {
    if (!isLevelEnabled("debug")) return;
    const isProd = process.env.NODE_ENV === "production";
    const sanitizedMeta = sanitizeValue(meta);
    if (isProd) {
      console.log(JSON.stringify({
        level: "debug",
        message,
        timestamp: new Date().toISOString(),
        ...sanitizedMeta,
      }));
    } else {
      console.log(`[DEBUG] 🔍 ${message}`, Object.keys(sanitizedMeta).length ? sanitizedMeta : '');
    }
  },

  /**
   * Informational logs (Lifecycle milestones, business transactions).
   */
  info: (message, meta = {}) => {
    if (!isLevelEnabled("info")) return;
    const isProd = process.env.NODE_ENV === "production";
    const sanitizedMeta = sanitizeValue(meta);
    if (isProd) {
      console.log(JSON.stringify({
        level: "info",
        message,
        timestamp: new Date().toISOString(),
        ...sanitizedMeta,
      }));
    } else {
      console.log(`[INFO] ℹ️  ${message}`, Object.keys(sanitizedMeta).length ? sanitizedMeta : '');
    }
  },

  /**
   * Recoverable warnings (Degraded mode, retry warnings, slow queries).
   */
  warn: (message, meta = {}) => {
    if (!isLevelEnabled("warn")) return;
    const isProd = process.env.NODE_ENV === "production";
    const sanitizedMeta = sanitizeValue(meta);
    if (isProd) {
      console.warn(JSON.stringify({
        level: "warn",
        message,
        timestamp: new Date().toISOString(),
        ...sanitizedMeta,
      }));
    } else {
      console.warn(`[WARN] ⚠️  ${message}`, Object.keys(sanitizedMeta).length ? sanitizedMeta : '');
    }
  },

  /**
   * Non-fatal errors and failed operations.
   */
  error: (message, error = null, meta = {}) => {
    if (!isLevelEnabled("error")) return;
    const isProd = process.env.NODE_ENV === "production";
    let errorObj = {};
    if (error instanceof Error) {
      errorObj = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: error.code,
      };
      // Send unhandled backend errors to Sentry if in production
      if (isProd) {
        Sentry.captureException(error);
      }
    } else if (typeof error === "object" && error !== null) {
      errorObj = sanitizeValue(error);
    }

    const sanitizedMeta = sanitizeValue(meta);

    if (isProd) {
      console.error(JSON.stringify({
        level: "error",
        message,
        error: errorObj,
        timestamp: new Date().toISOString(),
        ...sanitizedMeta,
      }));
    } else {
      console.error(`[ERROR] ❌ ${message}`, error || '', Object.keys(sanitizedMeta).length ? sanitizedMeta : '');
    }
  },

  /**
   * Unrecoverable service startup errors or crashes.
   */
  fatal: (message, error = null, meta = {}) => {
    const isProd = process.env.NODE_ENV === "production";
    let errorObj = {};
    if (error instanceof Error) {
      errorObj = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: error.code,
      };
      if (isProd) {
        Sentry.captureException(error);
      }
    } else if (typeof error === "object" && error !== null) {
      errorObj = sanitizeValue(error);
    }

    const sanitizedMeta = sanitizeValue(meta);

    if (isProd) {
      console.error(JSON.stringify({
        level: "fatal",
        message,
        error: errorObj,
        timestamp: new Date().toISOString(),
        ...sanitizedMeta,
      }));
    } else {
      console.error(`[FATAL] 🛑 ${message}`, error || '', Object.keys(sanitizedMeta).length ? sanitizedMeta : '');
    }
  },

  /**
   * High-level business event logs (login success/fail, job created, invoice issued, etc.).
   */
  business: (event, meta = {}) => {
    if (!isLevelEnabled("info")) return;
    const isProd = process.env.NODE_ENV === "production";
    const sanitizedMeta = sanitizeValue(meta);
    if (isProd) {
      console.log(JSON.stringify({
        level: "info",
        type: "business_event",
        event,
        timestamp: new Date().toISOString(),
        ...sanitizedMeta,
      }));
    } else {
      console.log(`[BUSINESS] 🏷️ ${event}`, Object.keys(sanitizedMeta).length ? sanitizedMeta : '');
    }
  },

  /**
   * Structured performance warning for slow queries or slow operations exceeding threshold.
   */
  slowQuery: (operationOrOpts, durationMsArg, metaArg = {}) => {
    if (!isLevelEnabled("warn")) return;
    const isProd = process.env.NODE_ENV === "production";

    let operation;
    let durationMs;
    let meta = {};

    if (typeof operationOrOpts === 'object' && operationOrOpts !== null) {
      operation = operationOrOpts.operation;
      durationMs = operationOrOpts.durationMs;
      meta = { ...operationOrOpts };
      delete meta.operation;
      delete meta.durationMs;
    } else {
      operation = operationOrOpts;
      durationMs = durationMsArg;
      meta = metaArg;
    }

    const sanitizedMeta = sanitizeValue(meta);
    const duration = typeof durationMs === 'number' ? Number(durationMs.toFixed(2)) : 0;

    if (isProd) {
      console.warn(JSON.stringify({
        level: "warn",
        type: "slow_query",
        event: "slow_query_warning",
        operation,
        durationMs: duration,
        timestamp: new Date().toISOString(),
        ...sanitizedMeta,
      }));
    } else {
      console.warn(`[SLOW_QUERY] ⏱️ ${operation} took ${duration}ms`, Object.keys(sanitizedMeta).length ? sanitizedMeta : '');
    }
  },
};

module.exports = logger;
