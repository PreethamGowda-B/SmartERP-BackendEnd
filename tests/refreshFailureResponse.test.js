const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sendRefreshUnavailable } = require('../utils/refreshFailureResponse');

test('unexpected refresh infrastructure failures return a retryable 503, not an invalid-session 401', () => {
  const response = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return payload; },
  };

  sendRefreshUnavailable(response);

  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.error, 'AUTH_SERVICE_UNAVAILABLE');
  assert.match(response.payload.message, /temporarily unavailable.*retry/i);
  assert.doesNotMatch(JSON.stringify(response.payload), /unauthorized|refresh token/i);
});

test('refresh route uses the retryable response only in its unexpected-error path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const refreshRoute = source.split('router.post("/refresh"')[1]?.split('// ---------------------------------------------')[0] || '';
  assert.match(source, /require\("\.\.\/utils\/refreshFailureResponse"\)/);
  assert.match(refreshRoute, /return sendRefreshUnavailable\(res\)/);
  assert.match(refreshRoute, /try \{\s*client = await pool\.connect\(\)/);
  assert.match(refreshRoute, /Invalid refresh token/);
  assert.match(refreshRoute, /Session was revoked/);
});
