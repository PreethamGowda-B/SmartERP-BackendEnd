/**
 * middleware/adminMiddleware.js
 * Strict authorization for platform-level administrative access.
 */

function authenticateSuperAdmin(req, res, next) {
  const user = req.user;
  
  if (!user) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;
  
  // Requirement 1: Role must be exactly 'super_admin'
  // Requirement 2: Email must match the verified developer email from environment variables (if set)
  if (user.role === 'super_admin' && (!superAdminEmail || user.email === superAdminEmail)) {
    console.log(`🛡️ Superadmin access granted to: ${user.email}`);
    return next();
  }

  console.warn(`🚫 Unauthorized Superadmin access attempt by: ${user.email || 'undefined'} (Role: ${user.role || 'none'}) for ${req.method} ${req.path}`);
  return res.status(403).json({ 
    message: "Access Denied: You do not have platform-level administrative privileges." 
  });
}

module.exports = { authenticateSuperAdmin };
