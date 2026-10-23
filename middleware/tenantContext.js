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

  const companyId = req.user.companyId || req.user.company_id;
  const role = req.user.role;
  const userId = req.user.id || req.user.userId;

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

  const existingStore = storage.getStore();
  // Missing tenant context must fail closed under the non-bypass app role.
  // Bypass is preserved only when a trusted server-side middleware explicitly
  // established it (for example, the auth router before identity lookup).
  // Never infer privileged database access from absent company data.
  const bypassRls = existingStore?.bypassRls === true;

  // Run the rest of the request chain inside the ALS context
  storage.run({ isWebRequest: true, companyId, role, userId, bypassRls }, () => {
    next();
  });
}

module.exports = { setTenantContext };
