'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const {
  createAuthRouteRlsScope,
  STAFF_IDENTITY_LOOKUP_ROUTES,
  CUSTOMER_IDENTITY_LOOKUP_ROUTES,
} = require('../middleware/authRouteRlsScope');

function invoke(scope, { method, path }) {
  const req = { method, path };
  let captured;
  scope(req, {}, () => { captured = storage.getStore(); });
  return captured;
}

const storage = new AsyncLocalStorage();
const scope = createAuthRouteRlsScope({
  storage,
  crossTenantRoutes: new Map([
    ['/login', new Set(['POST'])],
    ['/google/callback', new Set(['GET'])],
  ]),
});

test('auth route RLS scope grants explicit identity lookup only for allowlisted method and path', () => {
  assert.equal(invoke(scope, { method: 'POST', path: '/login' }).bypassRls, true);
  assert.equal(invoke(scope, { method: 'GET', path: '/google/callback' }).bypassRls, true);
  assert.equal(invoke(scope, { method: 'GET', path: '/login' }).bypassRls, false);
  assert.equal(invoke(scope, { method: 'POST', path: '/company/settings' }).bypassRls, false);
  assert.equal(invoke(scope, { method: 'DELETE', path: '/login' }).bypassRls, false);
  assert.equal(invoke(scope, { method: 'POST', path: '/unknown' }).bypassRls, false);
});

test('auth route RLS scope normalizes a trailing slash but does not broaden the path', () => {
  assert.equal(invoke(scope, { method: 'POST', path: '/login/' }).bypassRls, true);
  assert.equal(invoke(scope, { method: 'POST', path: '/login/extra' }).bypassRls, false);
});

test('known authenticated staff endpoints do not receive cross-tenant context', () => {
  for (const [method, path] of [
    ['POST', '/request-password-reset-otp'],
    ['GET', '/me'],
    ['GET', '/company/settings'],
    ['POST', '/company/generate-invite'],
    ['POST', '/update-push-token'],
  ]) {
    assert.equal(invoke(createAuthRouteRlsScope({ storage, crossTenantRoutes: STAFF_IDENTITY_LOOKUP_ROUTES }), { method, path }).bypassRls, false, `${method} ${path}`);
  }
});

test('employee onboarding is the one explicit temporary-token staff identity-linking exception', () => {
  assert.equal(invoke(createAuthRouteRlsScope({ storage, crossTenantRoutes: STAFF_IDENTITY_LOOKUP_ROUTES }), {
    method: 'POST', path: '/employee/onboarding',
  }).bypassRls, true);
});

test('customer cross-tenant context is restricted to enumerated authentication and bootstrap routes', () => {
  const customerScope = createAuthRouteRlsScope({ storage, crossTenantRoutes: CUSTOMER_IDENTITY_LOOKUP_ROUTES });
  assert.equal(invoke(customerScope, { method: 'POST', path: '/login' }).bypassRls, true);
  assert.equal(invoke(customerScope, { method: 'POST', path: '/onboarding' }).bypassRls, true);
  assert.equal(invoke(customerScope, { method: 'PUT', path: '/profile' }).bypassRls, false);
  assert.equal(invoke(customerScope, { method: 'POST', path: '/unknown' }).bypassRls, false);
});
