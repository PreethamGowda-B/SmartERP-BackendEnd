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
  if (!req.user) {
    return next();
  }

  const companyId = req.user.companyId;
  const role = req.user.role;
  const userId = req.user.id;

  if (!companyId && role !== 'super_admin') {
    console.warn(`⚠️ setTenantContext: Authenticated user ${userId || 'unknown'} has no companyId on ${req.method} ${req.path}`);
  }

  // Run the rest of the request chain inside the ALS context
  storage.run({ isWebRequest: true, companyId, role, userId }, () => {
    next();
  });
}

module.exports = { setTenantContext };
