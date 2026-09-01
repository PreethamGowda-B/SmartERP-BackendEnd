/**
 * middleware/rbac.js
 * Granular Role-Based Access Control
 */

const permissions = {
  owner: ['*'], // Full access
  admin: [
    'dashboard:read',
    'employees:read',
    'employees:write',
    'attendance:read',
    'attendance:write',
    'inventory:read',
    'inventory:write',
    'reports:read',
    'payroll:read',
    'payroll:write',
    'messages:read',
    'messages:write'
  ],
  employee: [
    'dashboard:read',
    'attendance:read',
    'attendance:write',
    'profile:read',
    'profile:write',
    'messages:read',
    'messages:write',
    'jobs:read',
    'jobs:write'
  ],
  hr: [
    'dashboard:read',
    'employees:read',
    'employees:write',
    'attendance:read',
    'attendance:write',
    'payroll:read',
    'payroll:write',
    'documents:read',
    'documents:write',
    'hr:read',
    'hr:write',
    'messages:read',
    'messages:write',
    'jobs:read',
    'inventory:read'
  ]
};

function checkPermission(requiredPermission) {
  return (req, res, next) => {
    const userRole = req.user?.role || 'employee';
    const userPermissions = permissions[userRole] || [];

    if (userPermissions.includes('*') || userPermissions.includes(requiredPermission)) {
      return next();
    }

    const { emitSecurityEvent, SECURITY_EVENT_TYPES } = require('../utils/securityEmitter');
    emitSecurityEvent({
      companyId: req.user?.companyId || req.user?.company_id,
      userId: req.user?.id || req.user?.userId,
      eventType: SECURITY_EVENT_TYPES.RBAC_DENIED,
      severity: 'low',
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
      endpoint: req.originalUrl || req.path,
      httpMethod: req.method,
      statusCode: 403,
      metadata: {
        userRole,
        requiredPermission,
      }
    });

    return res.status(403).json({
      message: `Access denied. You do not have permission to ${requiredPermission.replace(':', ' ')}.`,
      required: requiredPermission
    });
  };
}

module.exports = { checkPermission };
