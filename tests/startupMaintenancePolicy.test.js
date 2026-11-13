'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('production startup skips database maintenance unless explicitly enabled', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /const runStartupDbMaintenance = process\.env\.RUN_STARTUP_DB_MAINTENANCE === 'true';/);
  assert.match(server, /if \(runStartupDbMaintenance\) \{[\s\S]*?await runDatabaseInitialization\(\)/);
  assert.match(server, /Skipping startup database maintenance/);
});
