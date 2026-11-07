const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('staff OAuth errors redirect to the staff login route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');

  assert.match(source, /\$\{FRONTEND\}\/auth\/login\?error=oauth_failed/);
  assert.match(source, /\$\{FRONTEND\}\/auth\/login\?error=auth_failed/);
  assert.doesNotMatch(source, /\$\{FRONTEND\}\/login\?error=(?:oauth_failed|auth_failed)/);
});
