/**
 * middleware/tenantContext.js
 * Ensures Row-Level Security (RLS) is active for the current request.
 *
 * IMPORTANT: This middleware must run AFTER authenticateToken so that
 * req.user is already populated. It is called from within authenticateToken
 * (see authMiddleware.js) rather than as a standalone router-level middleware.
 */
const { storage } = require('./als');

function setTenantContext(req, res, next) {
  const companyId = req.user?.companyId;

  if (!companyId) {
    // If req.user exists but has no companyId, log a warning (authenticated orphan user)
    if (req.user && req.user.role !== 'super_admin') {
      console.warn(`⚠️ setTenantContext: Authenticated user ${req.user?.id || 'unknown'} has no companyId on ${req.method} ${req.path}`);
    }
    return next();
  }

  // Run the rest of the request chain inside the ALS context
  storage.run({ companyId }, () => {
    next();
  });
}

module.exports = { setTenantContext };
