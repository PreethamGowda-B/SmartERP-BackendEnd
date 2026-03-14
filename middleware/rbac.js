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
  ]
};

function checkPermission(requiredPermission) {
  return (req, res, next) => {
    const userRole = req.user?.role || 'employee';
    const userPermissions = permissions[userRole] || [];

    if (userPermissions.includes('*') || userPermissions.includes(requiredPermission)) {
      return next();
    }

    return res.status(403).json({
      message: `Access denied. You do not have permission to ${requiredPermission.replace(':', ' ')}.`,
      required: requiredPermission
    });
  };
}

module.exports = { checkPermission };
