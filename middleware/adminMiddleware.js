/**
 * middleware/adminMiddleware.js
 * Strict authorization for platform-level administrative access.
 */

function authenticateSuperAdmin(req, res, next) {
  const user = req.user;
  
  if (!user) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  // Check if role is super_admin or email matches SUPER_ADMIN_EMAIL env var
  const envSuperAdminEmail = process.env.SUPER_ADMIN_EMAIL?.toLowerCase().trim();
  const userEmail = user.email?.toLowerCase().trim();

  const isSuperAdminRole = user.role === 'super_admin';
  const matchesEnvEmail = Boolean(envSuperAdminEmail && userEmail === envSuperAdminEmail);

  if (isSuperAdminRole || matchesEnvEmail) {
    return next();
  }

  console.warn(`🚫 Unauthorized Superadmin access attempt by: ${user.email || 'undefined'} (Role: ${user.role || 'none'}) for ${req.method} ${req.path}`);
  
  const { emitSecurityEvent, SECURITY_EVENT_TYPES } = require('../utils/securityEmitter');
  emitSecurityEvent({
    companyId: user.companyId || user.company_id,
    userId: user.id || user.userId,
    eventType: SECURITY_EVENT_TYPES.ADMIN_UNAUTHORIZED,
    severity: 'high',
    ipAddress: req.ip || req.headers['x-forwarded-for'],
    userAgent: req.headers['user-agent'],
    endpoint: req.originalUrl || req.path,
    httpMethod: req.method,
    statusCode: 403,
    metadata: {
      userEmail: user.email,
      userRole: user.role,
    }
  });

  return res.status(403).json({ 
    message: "Access Denied: You do not have platform-level administrative privileges." 
  });
}

module.exports = { authenticateSuperAdmin };
