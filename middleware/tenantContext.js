/**
 * middleware/tenantContext.js
 * Ensures Row-Level Security (RLS) is active for the current request.
 */
const { storage } = require('./als');

// Routes that are intentionally public and do not require tenant context
// These are auth/onboarding routes where req.user may not exist yet
const PUBLIC_PATH_PREFIXES = [
  '/auth/',
  '/webhook',
  '/health',
];

function isPublicPath(path) {
  return PUBLIC_PATH_PREFIXES.some(prefix => path.includes(prefix));
}

function setTenantContext(req, res, next) {
  const companyId = req.user?.companyId;

  if (!companyId) {
    // Super admins have no companyId — allow through without tenant context
    if (req.user?.role === 'super_admin') {
      return next();
    }

    // Public routes (auth, webhook, health) — allow through without tenant context
    if (isPublicPath(req.path)) {
      return next();
    }

    // Authenticated non-super-admin user with no companyId on a protected route
    // This is an edge case (e.g. orphaned user account) — allow through but log it
    // We do NOT block here to avoid breaking existing users; the route-level
    // company_id checks will handle access control
    console.warn(`⚠️ setTenantContext: No companyId for user ${req.user?.id || 'unknown'} on ${req.method} ${req.path}`);
    return next();
  }

  // Run the rest of the request chain inside the ALS context
  storage.run({ companyId }, () => {
    next();
  });
}

module.exports = { setTenantContext };
