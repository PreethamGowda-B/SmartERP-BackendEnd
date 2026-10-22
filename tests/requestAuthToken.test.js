const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRequestAuthToken } = require('../middleware/requestAuthToken');

test('shared AI endpoint trusts the explicit Owner bearer over a stale superadmin cookie', () => {
  const token = selectRequestAuthToken({
    originalUrl: '/api/ai/agent',
    headers: { authorization: 'Bearer owner-session' },
    cookies: { superadmin_access_token: 'stale-admin-session' },
  });
  assert.equal(token, 'owner-session');
});

test('shared AI endpoint without a bearer cannot silently use a superadmin cookie', () => {
  const token = selectRequestAuthToken({
    originalUrl: '/api/ai/agent',
    headers: {},
    cookies: { superadmin_access_token: 'admin-session', user_access_token: 'owner-session' },
  });
  assert.equal(token, 'owner-session');
});

test('explicit Superadmin routes retain their existing Superadmin-cookie behavior', () => {
  const token = selectRequestAuthToken({
    originalUrl: '/api/superadmin/users',
    headers: { authorization: 'Bearer alternate-session' },
    cookies: { superadmin_access_token: 'admin-session' },
  });
  assert.equal(token, 'admin-session');
});

test('query-token authentication remains available for existing SSE routes', () => {
  const token = selectRequestAuthToken({
    originalUrl: '/api/attendance/stream',
    headers: {},
    query: { token: 'sse-session' },
    cookies: {},
  });
  assert.equal(token, 'sse-session');
});

test('notifications SSE ignores query tokens and uses the authenticated staff cookie', () => {
  const token = selectRequestAuthToken({
    originalUrl: '/api/notifications/sse?token=leaked-session',
    headers: {},
    query: { token: 'leaked-session' },
    cookies: { user_access_token: 'staff-cookie-session' },
  });
  assert.equal(token, 'staff-cookie-session');
});

test('versioned notifications SSE also rejects query tokens when no cookie is present', () => {
  const token = selectRequestAuthToken({
    originalUrl: '/api/v1/notifications/sse?token=leaked-session',
    headers: {},
    query: { token: 'leaked-session' },
    cookies: {},
  });
  assert.equal(token, null);
});

test('trailing slash notifications SSE cannot re-enable query-token authentication', () => {
  const token = selectRequestAuthToken({
    originalUrl: '/api/notifications/sse/?token=leaked-session',
    headers: {},
    query: { token: 'leaked-session' },
    cookies: {},
  });
  assert.equal(token, null);
});
