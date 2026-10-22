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
