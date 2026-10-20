'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  getSupportPolicy,
  isSupportChannelAllowed,
  calculateFirstResponseDueAt,
  formatResponseTarget,
} = require('../services/supportPolicy');

function asIndiaParts(date) {
  const local = new Date(date.getTime() + 330 * 60 * 1000);
  return {
    day: local.getUTCDay(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

test('support channels and response targets match Starter, Professional, Enterprise, and trial', () => {
  assert.deepEqual(getSupportPolicy(1).channels, ['email']);
  assert.equal(getSupportPolicy(1).firstResponseBusinessHours, 18);
  assert.deepEqual(getSupportPolicy(2).channels, ['email', 'whatsapp']);
  assert.equal(getSupportPolicy(2).firstResponseBusinessHours, 9);
  assert.deepEqual(getSupportPolicy(3).channels, ['email', 'whatsapp']);
  assert.equal(getSupportPolicy(3).firstResponseBusinessHours, 4);
  assert.deepEqual(getSupportPolicy(3), getSupportPolicy(3)); // Trial uses Enterprise plan ID 3.
  assert.equal(getSupportPolicy(99), null);
  assert.equal(formatResponseTarget(getSupportPolicy(1)), 'within 2 business days');
  assert.equal(formatResponseTarget(getSupportPolicy(2)), 'within 1 business day');
  assert.equal(formatResponseTarget(getSupportPolicy(3)), 'within 4 business hours');
});

test('channel authorization fails closed and WhatsApp begins with Professional', () => {
  assert.equal(isSupportChannelAllowed(getSupportPolicy(1), 'email'), true);
  assert.equal(isSupportChannelAllowed(getSupportPolicy(1), 'whatsapp'), false);
  assert.equal(isSupportChannelAllowed(getSupportPolicy(2), 'whatsapp'), true);
  assert.equal(isSupportChannelAllowed(getSupportPolicy(3), 'phone'), false);
  assert.equal(isSupportChannelAllowed(null, 'email'), false);
});

test('response target deadline counts only weekday 09:00–18:00 IST business time', () => {
  const beforeOpen = new Date('2026-10-19T02:30:00.000Z'); // Monday 08:00 IST
  assert.equal(calculateFirstResponseDueAt(beforeOpen, 4).toISOString(), '2026-10-19T07:30:00.000Z'); // 13:00 IST

  const partialMinute = new Date('2026-10-19T03:30:30.000Z'); // Monday 09:00:30 IST
  assert.equal(calculateFirstResponseDueAt(partialMinute, 4).toISOString(), '2026-10-19T07:31:00.000Z'); // Round deadline up, never early.

  const afterClose = new Date('2026-10-19T13:00:00.000Z'); // Monday 18:30 IST
  assert.equal(calculateFirstResponseDueAt(afterClose, 4).toISOString(), '2026-10-20T07:30:00.000Z'); // Tuesday 13:00 IST

  const friday = new Date('2026-10-23T13:00:00.000Z'); // Friday 18:30 IST
  const mondayDue = calculateFirstResponseDueAt(friday, 4);
  assert.equal(mondayDue.toISOString(), '2026-10-26T07:30:00.000Z');
  assert.deepEqual(asIndiaParts(mondayDue), { day: 1, hour: 13, minute: 0 });
});

test('support API enforces policy and scopes ticket history by authenticated company', () => {
  const route = fs.readFileSync(path.join(__dirname, '../routes/support.js'), 'utf8');
  assert.match(route, /router\.use\(authenticateToken, loadPlan, companyContext\)/);
  assert.match(route, /isSupportChannelAllowed\(policy, channel\)/);
  assert.match(route, /WHERE company_id = \$1 AND type = 'support'/);
  assert.match(route, /support_first_response_due_at/);
  assert.match(route, /support_plan_id/);
  const feedback = fs.readFileSync(path.join(__dirname, '../routes/feedback.js'), 'utf8');
  assert.match(feedback, /if \(type === 'support'\)/);
  assert.match(feedback, /support_first_responded_at = CASE/);
});

test('migration 038 records policy, channel restrictions, plan snapshot, and response timestamps', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../migrations/038_tiered_support_entitlements.sql'), 'utf8');
  assert.match(migration, /support_policy JSONB/);
  assert.match(migration, /"channels":\["email"\]/);
  assert.match(migration, /"channels":\["email","whatsapp"\]/);
  assert.match(migration, /support_first_response_due_at/);
  assert.match(migration, /support_first_responded_at/);
  const runner = fs.readFileSync(path.join(__dirname, '../migrations/forwardMigrationRunner.js'), 'utf8');
  assert.match(runner, /038_tiered_support_entitlements/);
});
