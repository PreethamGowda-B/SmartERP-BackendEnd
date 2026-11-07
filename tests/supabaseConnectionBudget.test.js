const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePoolMax, DEFAULT_DB_POOL_MAX } = require('../db-base');

const BACKEND_ROOT = path.resolve(__dirname, '..');

test('Supabase session mode connection budget is safely bounded', () => {
  // Supavisor session mode limit on Supabase is 15 connections
  const SUPABISOR_SESSION_LIMIT = 15;
  const TYPICAL_WORKERS = 2;
  const ROLLING_DEPLOY_PROCESSES = 4; // 2 old workers + 2 new workers

  assert.equal(DEFAULT_DB_POOL_MAX, 2, 'Default pool max must be 2 per process');
  assert.equal(resolvePoolMax(undefined), 2);
  assert.equal(resolvePoolMax(''), 2);

  // Total connections across all workers during normal operation
  const normalTotalConnections = DEFAULT_DB_POOL_MAX * TYPICAL_WORKERS;
  assert.ok(
    normalTotalConnections <= 6,
    `Normal simultaneous connections (${normalTotalConnections}) must be well below Supabase limit (${SUPABISOR_SESSION_LIMIT})`
  );

  // Total connections during a zero-downtime deployment rollover
  const rolloverTotalConnections = DEFAULT_DB_POOL_MAX * ROLLING_DEPLOY_PROCESSES;
  assert.ok(
    rolloverTotalConnections < SUPABISOR_SESSION_LIMIT,
    `Deployment rollover connections (${rolloverTotalConnections}) must never exceed Supavisor limit (${SUPABISOR_SESSION_LIMIT})`
  );
});

test('daily attendance processor prevents overlapping passes and connection exhaustion', () => {
  const code = fs.readFileSync(path.join(BACKEND_ROOT, 'jobs', 'dailyAttendanceProcessor.js'), 'utf8');

  // Verify in-memory lock prevents concurrent cron schedule overlapping
  assert.ok(code.includes('_attendanceRunning'), 'Attendance processor must have an in-flight execution guard');
  assert.ok(code.includes('pg_try_advisory_xact_lock'), 'Must use try_advisory_xact_lock to prevent blocking pool connections');
});

test('SLA service prevents overlapping audit and breach detection passes', () => {
  const code = fs.readFileSync(path.join(BACKEND_ROOT, 'services', 'slaService.js'), 'utf8');

  assert.ok(code.includes('_slaRunning'), 'SLA service must guard against concurrent reentrancy');
});
