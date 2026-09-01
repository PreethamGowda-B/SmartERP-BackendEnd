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

  // Cross-tenant mismatch signal: Check if caller explicitly probes another tenant ID via headers or query
  const explicitTarget = req.headers['x-company-id'] || req.query?.company_id || req.query?.companyId;
  if (explicitTarget && companyId && String(explicitTarget) !== String(companyId) && role !== 'super_admin') {
    const { emitSecurityEvent, SECURITY_EVENT_TYPES } = require('../utils/securityEmitter');
    emitSecurityEvent({
      companyId: String(companyId),
      userId: String(userId),
      eventType: SECURITY_EVENT_TYPES.TENANT_MISMATCH,
      severity: 'medium',
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
      endpoint: req.originalUrl || req.path,
      httpMethod: req.method,
      statusCode: 403,
      metadata: {
        reason: 'Client requested mismatched tenant ID',
        claimedCompanyId: String(explicitTarget).slice(0, 50),
      }
    });
  }

  // Run the rest of the request chain inside the ALS context
  storage.run({ isWebRequest: true, companyId, role, userId }, () => {
    next();
  });
}

module.exports = { setTenantContext };
