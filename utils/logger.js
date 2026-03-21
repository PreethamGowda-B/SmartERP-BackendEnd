const Sentry = require("@sentry/node");

// Helper to determine active environment for log formatting
const isProd = process.env.NODE_ENV === "production";

/**
 * 📝 Structured App Logger
 * In Production: Spits out parsable JSON (extremely fast/lightweight for Render log streams).
 * In Development: Uses console blocks with emojis.
 * Errors automatically report context to Sentry.
 */
const logger = {
  info: (message, meta = {}) => {
    if (isProd) {
      console.log(JSON.stringify({ level: "info", timestamp: new Date().toISOString(), message, ...meta }));
    } else {
      console.log(`[INFO] ℹ️ ${message}`, Object.keys(meta).length ? meta : '');
    }
  },

  warn: (message, meta = {}) => {
    if (isProd) {
      console.warn(JSON.stringify({ level: "warn", timestamp: new Date().toISOString(), message, ...meta }));
    } else {
      console.warn(`[WARN] ⚠️ ${message}`, Object.keys(meta).length ? meta : '');
    }
  },

  error: (message, error = null, meta = {}) => {
    // Standardize error data format
    const errorData = error instanceof Error 
      ? { message: error.message, stack: error.stack } 
      : { message: String(error || "Unknown Error") };

    // Fire off to Sentry for tracking
    if (error && process.env.SENTRY_DSN) {
      Sentry.captureException(error, { extra: { context: message, ...meta } });
    }

    if (isProd) {
      console.error(JSON.stringify({ 
        level: "error", 
        timestamp: new Date().toISOString(), 
        message, 
        error: errorData, 
        ...meta 
      }));
    } else {
      console.error(`[ERROR] ❌ ${message}`, errorData.message || '', Object.keys(meta).length ? meta : '');
      if (errorData.stack) {
        console.error(errorData.stack);
      }
    }
  },

  debug: (message, meta = {}) => {
    // Debugs only ever output in development context to save IO
    if (!isProd) {
      console.debug(`[DEBUG] 🐛 ${message}`, Object.keys(meta).length ? meta : '');
    }
  }
};

module.exports = logger;
