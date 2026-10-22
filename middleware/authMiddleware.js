const jwt = require("jsonwebtoken");
const { redisClient } = require("../utils/redis");
const { setTenantContext } = require("./tenantContext");
const { getRequestPath, isSuperAdminRoute, selectRequestAuthToken } = require("./requestAuthToken");
const { storage } = require('./als');
const { verifyAccessAccountState } = require('./authAccountState');
const { createCompanySuspensionChecker } = require('./companySuspensionState');

const isCompanySuspended = createCompanySuspensionChecker(async (companyId) => {
  const { pool } = require("../db");
  return pool.query(
    "SELECT status, COALESCE(NULLIF(to_jsonb(c)->>'is_suspended', ''), 'false') as is_susp FROM companies c WHERE id = $1",
    [companyId]
  );
});

async function authenticateToken(req, res, next) {
  const token = selectRequestAuthToken(req);
  const requestPath = getRequestPath(req);
  const isAdminRoute = isSuperAdminRoute(requestPath);

  if (!token) {
    // Only log in debug mode — these are normal during token refresh cycles
    if (process.env.LOG_AUTH_FAILURES === 'true') {
      const hasCookies = req.cookies && Object.keys(req.cookies).length > 0;
      console.log(`ℹ️ No token found for ${req.method} ${requestPath} (Origin: ${req.headers.origin || req.headers.host}${hasCookies ? ' | Has Cookies' : ''})`);
    }
    return res.status(401).json({ message: "Not authenticated" });
  }

  const { emitSecurityEvent, SECURITY_EVENT_TYPES } = require("../utils/securityEmitter");

  // Dual-secret support for zero-downtime secret rotation
  let verifiedPayload = null;
  let verificationError = null;

  try {
    verifiedPayload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err1) {
    verificationError = err1;
    if (process.env.JWT_SECRET_OLD) {
      try {
        verifiedPayload = jwt.verify(token, process.env.JWT_SECRET_OLD);
        verificationError = null;
      } catch (_) {
        // failed with both current and old secret
      }
    }
  }

  if (!verifiedPayload) {
    emitSecurityEvent({
      eventType: SECURITY_EVENT_TYPES.AUTH_TOKEN_INVALID,
      severity: 'low',
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
      endpoint: requestPath,
      httpMethod: req.method,
      statusCode: 401,
      metadata: {
        errorName: verificationError ? verificationError.name : 'JsonWebTokenError',
      }
    });
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  const payload = verifiedPayload;

    if (payload.role === 'customer') {
      emitSecurityEvent({
        userId: payload.id || payload.userId,
        eventType: SECURITY_EVENT_TYPES.RBAC_DENIED,
        severity: 'medium',
        ipAddress: req.ip || req.headers['x-forwarded-for'],
        userAgent: req.headers['user-agent'],
        endpoint: requestPath,
        httpMethod: req.method,
        statusCode: 403,
        metadata: {
          reason: 'Customer token attempted access to staff endpoint',
        }
      });
      return res.status(403).json({ message: "Access denied: Customer tokens cannot access staff endpoints" });
    }
    
    // Ensure companyId is present (fallback to DB lookup if missing from older token)
    let companyId = payload.companyId || payload.company_id;
    if (!companyId && payload.role !== 'super_admin' && (payload.id || payload.userId)) {
      try {
        const { pool } = require("../db");
        const userDb = await storage.run({ isWebRequest: true, bypassRls: true }, () =>
          pool.query("SELECT company_id FROM users WHERE id = $1", [payload.id || payload.userId])
        );
        if (userDb.rows.length > 0 && userDb.rows[0].company_id) {
          companyId = userDb.rows[0].company_id;
          payload.companyId = companyId;
          payload.company_id = companyId;
        }
      } catch (_) {}
    }

    // Every valid staff JWT is checked against the current account state. This
    // makes Super Admin deactivation and approved staff suspension effective
    // before an access token expires. The trusted lookup explicitly opts into
    // the repository's auth-route RLS bypass for this single user-id query.
    const userId = payload.id || payload.userId;
    try {
      const { pool } = require('../db');
      const accountState = await storage.run(
        { isWebRequest: true, bypassRls: true },
        () => verifyAccessAccountState({ pool, redisClient, userId, tokenIssuedAt: payload.iat })
      );
      if (!accountState.allowed) {
        const isInactive = accountState.reason === 'user_inactive';
        return res.status(isInactive ? 403 : 401).json({
          message: isInactive ? 'Account Suspended/Disabled' : 'Session is no longer valid',
          error: isInactive ? 'account_suspended' : (accountState.reason === 'session_revoked' ? 'token_revoked' : accountState.reason),
          ...(isInactive ? {
            details: 'Your account is suspended/disabled because of some unusual activities found in your account. Please contact our customer care to reactivate account. Customer care email: prozyncinnovations@gmail.com'
          } : {})
        });
      }
    } catch (error) {
      console.error('Authentication account-state check failed:', error?.code || 'ACCOUNT_STATE_UNAVAILABLE');
      return res.status(503).json({ message: 'Unable to verify account status. Please retry.' });
    }

    // Check authoritative company status each request; simultaneous requests
    // share only the in-flight query, never a completed status value.
    if (payload.role !== 'super_admin' && companyId) {
      try {
        const suspended = await storage.run(
          { isWebRequest: true, bypassRls: true },
          () => isCompanySuspended(companyId)
        );
        if (suspended) {
          console.warn(`🛑 Blocked access for suspended company: ${companyId} (User: ${payload.email})`);
          emitSecurityEvent({
            companyId: String(companyId),
            userId: payload.id || payload.userId,
            eventType: SECURITY_EVENT_TYPES.AUTH_COMPANY_SUSPENDED,
            severity: 'medium',
            ipAddress: req.ip || req.headers['x-forwarded-for'],
            userAgent: req.headers['user-agent'],
            endpoint: requestPath,
            httpMethod: req.method,
            statusCode: 403,
            metadata: {
              email: payload.email,
            }
          });
          return res.status(403).json({ 
            message: "Account Suspended/Disabled", 
            error: "your_company_is_suspended",
            details: "Your account is suspended/disabled because of some unusual activities found in your account. Please contact our customer care to reactivate account. Customer care email: prozyncinnovations@gmail.com"
          });
        }
      } catch (e) {
        console.error("Error checking suspension status:", e?.code || 'COMPANY_STATUS_UNAVAILABLE');
        return res.status(503).json({ message: 'Unable to verify company status. Please retry.' });
      }
    }

    req.user = {
      ...payload,
      id: payload.id || payload.userId,
      userId: payload.id || payload.userId,
      companyId: companyId,
      company_id: companyId,
      role: (payload.role || 'employee').toLowerCase()
    };

    // ✅ Activate RLS tenant context immediately after auth so all downstream
    // DB queries run inside the correct company scope.
    setTenantContext(req, res, next);
}

module.exports = { authenticateToken, isCompanySuspended };
