'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  INACTIVITY_TIMEOUT_DAYS,
  INACTIVITY_TIMEOUT_MS,
  ROTATION_GRACE_PERIOD_MS,
  isSessionInactive,
  getRemainingInactivityMs,
  isPassiveBackgroundRequest,
  evaluateTokenInactivity,
  handleConcurrentRotation,
} = require('../services/sessionLifecycleService');

test('Session Lifecycle - Constants and Configuration', () => {
  assert.equal(INACTIVITY_TIMEOUT_DAYS, 7, 'Inactivity timeout must be exactly 7 days');
  assert.equal(INACTIVITY_TIMEOUT_MS, 7 * 24 * 60 * 60 * 1000, 'Inactivity timeout ms must be 604,800,000 ms');
  assert.equal(ROTATION_GRACE_PERIOD_MS, 30 * 1000, 'Rotation concurrency grace period must be 30 seconds');
});

test('Test A: User inactive for 14 days is expired', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  const fourteenDaysAgo = new Date('2026-10-23T12:00:00Z');

  const inactive = isSessionInactive(fourteenDaysAgo, now);
  assert.equal(inactive, true, 'Session inactive for 14 days must be expired');

  const remaining = getRemainingInactivityMs(fourteenDaysAgo, now);
  assert.equal(remaining, 0, 'Remaining time for 14-day inactive session must be 0');

  const evalResult = evaluateTokenInactivity({ last_activity_at: fourteenDaysAgo }, now);
  assert.equal(evalResult.isInactive, true);
  assert.equal(evalResult.remainingMs, 0);
});

test('Test B: User active yesterday is valid and preserved', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  const yesterday = new Date('2026-11-05T12:00:00Z');

  const inactive = isSessionInactive(yesterday, now);
  assert.equal(inactive, false, 'Session active yesterday must be valid');

  const remaining = getRemainingInactivityMs(yesterday, now);
  assert.ok(remaining > 5 * 24 * 60 * 60 * 1000, 'Remaining time should be ~6 days');

  const evalResult = evaluateTokenInactivity({ last_activity_at: yesterday }, now);
  assert.equal(evalResult.isInactive, false);
});

test('Test C: Rolling window extends when user is active regularly', () => {
  let simulatedLastActivity = new Date('2026-10-01T10:00:00Z');

  // Day 3 activity
  let day3 = new Date('2026-10-04T10:00:00Z');
  assert.equal(isSessionInactive(simulatedLastActivity, day3), false);
  simulatedLastActivity = day3; // Rolling update

  // Day 6 activity
  let day6 = new Date('2026-10-07T10:00:00Z');
  assert.equal(isSessionInactive(simulatedLastActivity, day6), false);
  simulatedLastActivity = day6; // Rolling update

  // Day 10 activity (4 days after day 6)
  let day10 = new Date('2026-10-11T10:00:00Z');
  assert.equal(isSessionInactive(simulatedLastActivity, day10), false);
  simulatedLastActivity = day10; // Rolling update

  // Day 20 activity (10 days after day 10 - exceeded 7 days!)
  let day20 = new Date('2026-10-21T10:00:00Z');
  assert.equal(isSessionInactive(simulatedLastActivity, day20), true);
});

test('Test D: Exact 7-day boundary precision', () => {
  const refTime = new Date('2026-11-06T12:00:00.000Z');

  // 6 days, 23 hours, 59 minutes, 59 seconds ago -> ACTIVE (1s before cutoff)
  const activeBoundary = new Date(refTime.getTime() - (7 * 24 * 60 * 60 * 1000 - 1000));
  assert.equal(isSessionInactive(activeBoundary, refTime), false, '6d 23h 59m 59s must be ACTIVE');

  // Exactly 7 days + 1 millisecond -> INACTIVE
  const inactiveBoundary = new Date(refTime.getTime() - (7 * 24 * 60 * 60 * 1000 + 1));
  assert.equal(isSessionInactive(inactiveBoundary, refTime), true, '7d + 1ms must be INACTIVE');
});

test('Test E & F: Fallback timestamp evaluation when last_activity_at is null', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  const oldDate = new Date('2026-10-01T12:00:00Z');

  // Should fallback to updated_at then created_at
  const evalWithFallback = evaluateTokenInactivity({
    last_activity_at: null,
    updated_at: oldDate,
    created_at: oldDate,
  }, now);

  assert.equal(evalWithFallback.isInactive, true, 'Should use fallback timestamps and detect inactivity');
});

test('Test G: Concurrency Grace Period avoids false-positive replay attacks', async () => {
  const now = new Date('2026-11-06T12:00:00.000Z');

  // Token was rotated 5 seconds ago (within 30s grace period)
  const concurrentRotatedToken = {
    id: 'tok-123',
    token_family: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    revoked: true,
    revoked_at: new Date(now.getTime() - 5000), // 5s ago
  };

  const mockClient = {
    query: async (sql, params) => {
      // Returns the newly rotated active token for this family
      return {
        rows: [{
          id: 'tok-124',
          token_family: params[0],
          revoked: false,
          created_at: new Date(now.getTime() - 4900),
        }],
      };
    },
  };

  const result = await handleConcurrentRotation({
    tokenRow: concurrentRotatedToken,
    table: 'refresh_tokens',
    client: mockClient,
    now,
  });

  assert.equal(result.isGracePeriod, true, 'Should be within concurrency grace period');
  assert.equal(result.isReplay, false, 'Should NOT be treated as replay attack');
  assert.equal(result.activeTokenRow.id, 'tok-124', 'Should provide active token row');
});

test('Test G (part 2): Genuine replay outside 30s grace window is rejected', async () => {
  const now = new Date('2026-11-06T12:00:00.000Z');

  // Token was revoked 60 seconds ago (>30s grace period)
  const replayToken = {
    id: 'tok-old',
    token_family: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    revoked: true,
    revoked_at: new Date(now.getTime() - 60000), // 60s ago
  };

  const mockClient = { query: async () => ({ rows: [] }) };

  const result = await handleConcurrentRotation({
    tokenRow: replayToken,
    table: 'refresh_tokens',
    client: mockClient,
    now,
  });

  assert.equal(result.isGracePeriod, false, 'Should be outside grace period');
  assert.equal(result.isReplay, true, 'Must be flagged as genuine replay attack');
});

test('Test H: Passive background requests do NOT extend inactivity window', () => {
  // SSE notifications stream
  const sseReq = { originalUrl: '/api/notifications/sse', headers: {} };
  assert.equal(isPassiveBackgroundRequest(sseReq), true);

  // Customer SSE notifications
  const custSseReq = { originalUrl: '/api/customer/sse', headers: {} };
  assert.equal(isPassiveBackgroundRequest(custSseReq), true);

  // Health checks
  const healthReq = { originalUrl: '/api/health', headers: {} };
  assert.equal(isPassiveBackgroundRequest(healthReq), true);

  // Background location ping
  const bgLocationReq = {
    originalUrl: '/api/location/update',
    headers: { 'x-silent-background': 'true' },
  };
  assert.equal(isPassiveBackgroundRequest(bgLocationReq), true);

  // Normal user operational request (e.g. jobs, dashboard, attendance)
  const normalUserReq = { originalUrl: '/api/dashboard/owner/metrics', headers: {} };
  assert.equal(isPassiveBackgroundRequest(normalUserReq), false, 'Normal user actions must NOT be passive');
});

test('Test I: Route verification for inactivity check and cookie clearing', () => {
  const staffAuthSrc = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
  assert.match(staffAuthSrc, /evaluateTokenInactivity/, 'Staff auth must import and use evaluateTokenInactivity');
  assert.match(staffAuthSrc, /SESSION_EXPIRED_INACTIVITY/, 'Staff auth must return SESSION_EXPIRED_INACTIVITY');
  assert.match(staffAuthSrc, /handleConcurrentRotation/, 'Staff auth must check concurrency grace period');

  const customerAuthSrc = fs.readFileSync(path.join(__dirname, '../routes/customer/auth.js'), 'utf8');
  assert.match(customerAuthSrc, /evaluateTokenInactivity/, 'Customer auth must import and use evaluateTokenInactivity');
  assert.match(customerAuthSrc, /SESSION_EXPIRED_INACTIVITY/, 'Customer auth must return SESSION_EXPIRED_INACTIVITY');
  assert.match(customerAuthSrc, /handleConcurrentRotation/, 'Customer auth must check concurrency grace period');
});
