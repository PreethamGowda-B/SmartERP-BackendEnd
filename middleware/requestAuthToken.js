function matchesPath(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function getRequestPath(req) {
  return String(req.originalUrl || req.url || req.path || "").split("?", 1)[0];
}

function isSuperAdminRoute(path) {
  return ["/api/admin", "/api/superadmin", "/api/v1/superadmin"].some((prefix) => matchesPath(path, prefix));
}

function isRoleScopedAIRoute(path) {
  return matchesPath(path, "/api/ai") || matchesPath(path, "/api/v1/ai");
}

/**
 * Select credentials without letting a stale superadmin cookie override the
 * explicitly authenticated Owner/Employee session on shared AI endpoints.
 */
function selectRequestAuthToken(req) {
  const path = getRequestPath(req);
  const cookies = req.cookies || {};

  if (isSuperAdminRoute(path) && cookies.superadmin_access_token) {
    return cookies.superadmin_access_token;
  }

  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  if (req.query?.token) return req.query.token;

  if (isRoleScopedAIRoute(path)) {
    // AI is available to multiple staff roles. Without a Bearer token, use the
    // staff cookie only; never silently elevate the request via admin cookies.
    return cookies.user_access_token || cookies.access_token || null;
  }

  return cookies.superadmin_access_token || cookies.user_access_token || cookies.access_token || null;
}

module.exports = { getRequestPath, isSuperAdminRoute, isRoleScopedAIRoute, selectRequestAuthToken };
