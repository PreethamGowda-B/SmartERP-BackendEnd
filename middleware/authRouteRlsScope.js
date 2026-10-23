'use strict';

/**
 * Select an explicit RLS context for authentication routers. Only routes that
 * must discover an identity before a trusted tenant is available receive the
 * cross-tenant lookup context. Every other route starts fail-closed and must
 * establish its own authenticated tenant context before database access.
 */
function createAuthRouteRlsScope({ storage, crossTenantRoutes }) {
  if (!storage?.run || !(crossTenantRoutes instanceof Map)) {
    throw new TypeError('Auth route RLS scope requires storage and a route map.');
  }

  return function authRouteRlsScope(req, res, next) {
    const method = String(req.method || '').toUpperCase();
    const routePath = String(req.path || '/').replace(/\/$/, '') || '/';
    const allowedMethods = crossTenantRoutes.get(routePath);
    const needsIdentityLookup = allowedMethods?.has(method) === true;

    return storage.run({ isWebRequest: true, bypassRls: needsIdentityLookup }, next);
  };
}

const STAFF_IDENTITY_LOOKUP_ROUTES = new Map([
  ['/google', new Set(['GET'])],
  ['/google/callback', new Set(['GET'])],
  ['/exchange-code', new Set(['POST'])],
  ['/send-otp', new Set(['POST'])],
  ['/forgot-password', new Set(['POST'])],
  ['/verify-reset-otp', new Set(['POST'])],
  ['/reset-password', new Set(['POST'])],
  ['/signup', new Set(['POST'])],
  ['/check-email', new Set(['POST'])],
  ['/login', new Set(['POST'])],
  ['/refresh', new Set(['POST'])],
  ['/logout', new Set(['POST'])],
  ['/validate-company', new Set(['POST'])],
  // This temporary-token onboarding route validates a company code and links
  // an authenticated identity whose tenant is not established yet.
  ['/employee/onboarding', new Set(['POST'])],
]);

const CUSTOMER_IDENTITY_LOOKUP_ROUTES = new Map([
  ['/csrf', new Set(['GET'])],
  ['/send-otp', new Set(['POST'])],
  ['/verify-otp', new Set(['POST'])],
  ['/signup', new Set(['POST'])],
  ['/login', new Set(['POST'])],
  ['/refresh', new Set(['POST'])],
  ['/logout', new Set(['POST'])],
  ['/onboarding', new Set(['POST'])],
  ['/validate-company', new Set(['GET'])],
  ['/forgot-password', new Set(['POST'])],
  ['/verify-reset-otp', new Set(['POST'])],
  ['/reset-password', new Set(['POST'])],
]);

module.exports = {
  createAuthRouteRlsScope,
  STAFF_IDENTITY_LOOKUP_ROUTES,
  CUSTOMER_IDENTITY_LOOKUP_ROUTES,
};
