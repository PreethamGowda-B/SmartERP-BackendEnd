'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FAST_PATH_POLICIES,
  classifyAiFastPathIntent,
  authorizeAiFastPath,
} = require('../services/aiFastPathPolicy');

const plan = (id, aiAssistant = true) => ({ id, features: { ai_assistant: aiAssistant } });
const tierByPlanId = { 1: 'starter', 2: 'professional', 3: 'enterprise' };
const authorize = (message, role, planId, extra = {}) => {
  const intent = classifyAiFastPathIntent(message, role);
  return {
    intent,
    decision: authorizeAiFastPath({
      intent,
      role,
      companyId: 'company-authenticated',
      userId: role === 'employee' ? 'employee-authenticated' : 'user-authenticated',
      plan: plan(planId, extra.aiAssistant !== false),
      planTier: tierByPlanId[planId],
      modelScopes: extra.modelScopes ?? [],
      autoMode: extra.autoMode ?? true,
    }),
  };
};

test('every protected deterministic intent has an explicit authorization policy', () => {
  for (const intent of [
    'assigned_jobs', 'completed_jobs', 'active_jobs', 'attendance', 'payroll',
    'inventory', 'finance', 'finance_unpaid_invoices', 'gst', 'finance_gst_mixed', 'pending_leave',
  ]) assert.ok(FAST_PATH_POLICIES[intent], `missing policy for ${intent}`);
});

test('Starter general entitlement allows approved company job summaries only to managers', () => {
  const owner = authorize('How many jobs are completed?', 'owner', 1);
  assert.equal(owner.intent.key, 'completed_jobs');
  assert.equal(owner.decision.allowed, true);
  assert.equal(owner.decision.runDeterministic, true);
  const employee = authorize('How many jobs are completed?', 'employee', 3);
  assert.equal(employee.decision.code, 'AI_ROLE_FORBIDDEN');
});

test('employee job and leave summaries stay personal while company attendance requests are denied', () => {
  assert.equal(authorize('Show my assigned jobs', 'employee', 1).decision.allowed, true);
  const leave = authorize('Show my pending leave requests', 'employee', 1);
  assert.equal(leave.decision.allowed, true);
  assert.deepEqual(leave.decision.requiredScopes, ['general']);

  const personalAttendance = authorize('Show my attendance summary', 'employee', 2, { modelScopes: ['attendance'], autoMode: false });
  assert.equal(personalAttendance.decision.allowed, true);
  assert.equal(personalAttendance.intent.recordScope, 'personal');
  assert.equal(authorize('Who is present today?', 'employee', 3).decision.code, 'AI_RECORD_SCOPE_FORBIDDEN');
  assert.equal(authorize("Show John's attendance", 'employee', 3).decision.code, 'AI_RECORD_SCOPE_FORBIDDEN');
});

test('specialist entitlements and role checks are independent', () => {
  assert.equal(authorize('Show attendance summary', 'owner', 1).decision.code, 'AI_MODEL_NOT_INCLUDED');
  assert.equal(authorize('Show low stock inventory', 'employee', 3).decision.code, 'AI_ROLE_FORBIDDEN');
  assert.equal(authorize('Show payroll summary', 'employee', 3).decision.code, 'AI_ROLE_FORBIDDEN');
  assert.equal(authorize('Show payroll summary', 'admin', 3).decision.allowed, true);
  assert.equal(authorize('Show payroll summary', 'hr', 3).decision.code, 'AI_ROLE_FORBIDDEN');
  assert.equal(authorize('Show revenue summary', 'owner', 2).decision.code, 'AI_MODEL_NOT_INCLUDED');
  assert.equal(authorize('Show GST reconciliation summary', 'admin', 3).decision.allowed, true);
  assert.equal(authorize('Show GST reconciliation summary', 'hr', 3).decision.code, 'AI_ROLE_FORBIDDEN');
});

test('finance, GST, mixed, and ambiguous intents are classified before protected access', () => {
  assert.equal(classifyAiFastPathIntent('Summarize revenue', 'owner').key, 'finance');
  assert.equal(classifyAiFastPathIntent('Show GST reconciliation', 'owner').key, 'gst');
  const finance = authorize('Summarize revenue', 'owner', 3);
  assert.deepEqual(finance.decision.requiredScopes, ['finance']);
  assert.equal(authorize('Summarize revenue', 'owner', 3, { modelScopes: ['gst'], autoMode: false }).decision.code, 'AI_MODEL_INTENT_MISMATCH');
  const gstOnly = authorize('Show GST reconciliation', 'owner', 3);
  assert.deepEqual(gstOnly.decision.requiredScopes, ['gst']);
  const mixed = authorize('Compare finance and GST totals', 'owner', 3);
  assert.equal(mixed.intent.key, 'finance_gst_mixed');
  assert.deepEqual(mixed.decision.requiredScopes, ['finance', 'gst']);
  const missingOne = authorize('Compare finance and GST totals', 'owner', 3, { modelScopes: ['finance'], autoMode: false });
  assert.equal(missingOne.decision.code, 'AI_MODEL_INTENT_MISMATCH');
  assert.equal(classifyAiFastPathIntent('Show my GST invoice', 'owner').key, 'finance_gst_ambiguous');
  assert.equal(authorize('Show my GST invoice', 'owner', 3).decision.clarification, true);
});

test('missing context, disabled general AI, malformed scopes, and unknown protected intents fail closed', () => {
  const unknown = classifyAiFastPathIntent('Show employee records from another module', 'owner');
  const unknownDecision = authorizeAiFastPath({
    intent: unknown, role: 'owner', companyId: 'company-a', userId: 'owner-a',
    plan: plan(3), planTier: 'enterprise',
  });
  assert.equal(unknownDecision.code, 'AI_INTENT_UNAVAILABLE');

  const validIntent = classifyAiFastPathIntent('Show attendance summary', 'owner');
  assert.equal(authorizeAiFastPath({ intent: validIntent, role: 'owner', plan: plan(3), planTier: 'enterprise' }).code, 'AI_AUTH_CONTEXT_UNAVAILABLE');
  assert.equal(authorizeAiFastPath({ intent: validIntent, role: 'owner', companyId: 'c', userId: 'u', plan: plan(3, false), planTier: 'enterprise' }).code, 'AI_PLAN_UNAVAILABLE');
  assert.equal(authorizeAiFastPath({ intent: validIntent, role: 'owner', companyId: 'c', userId: 'u', plan: plan(3), planTier: null }).code, 'AI_PLAN_UNAVAILABLE');
  assert.equal(authorizeAiFastPath({ intent: validIntent, role: 'owner', companyId: 'c', userId: 'u', plan: plan(3), planTier: 'unknown-tier' }).code, 'AI_PLAN_UNAVAILABLE');
  assert.equal(authorizeAiFastPath({ intent: validIntent, role: 'owner', companyId: 'c', userId: 'u', plan: plan(3), planTier: 'enterprise', modelScopes: 'attendance' }).code, 'AI_MODEL_SELECTION_INVALID');
});

test('manual scopes cannot bypass or silently substitute for the intent entitlement', () => {
  const mismatch = authorize('Audit low stock inventory', 'owner', 3, { modelScopes: ['finance'], autoMode: false });
  assert.equal(mismatch.decision.code, 'AI_MODEL_INTENT_MISMATCH');
  const unavailable = authorize('Show attendance summary', 'owner', 2, { modelScopes: ['payroll'], autoMode: false });
  assert.equal(unavailable.decision.code, 'AI_MODEL_NOT_INCLUDED');
});
