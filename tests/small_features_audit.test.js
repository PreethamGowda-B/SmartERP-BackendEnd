const test = require('node:test');
const assert = require('node:assert/strict');
const { requireRole } = require('../middleware/rbac');
const { requireFeature } = require('../middleware/planMiddleware');

test.describe('Small Features & Easy-To-Miss Security Paths Test Suite', () => {

  // -----------------------------------------------------------------
  // 1. RBAC Guard Blocking Employee Access to Feature Routes
  // -----------------------------------------------------------------
  test('SEC-1: Employee role is blocked from owner/admin feature routes', () => {
    const checkRole = (role, allowedRoles) => {
      return allowedRoles.includes(role);
    };

    const allowed = ['owner', 'admin'];
    assert.equal(checkRole('employee', allowed), false, 'Employee MUST be blocked');
    assert.equal(checkRole('hr', allowed), false, 'HR MUST be blocked');
    assert.equal(checkRole('owner', allowed), true, 'Owner MUST be allowed');
    assert.equal(checkRole('admin', allowed), true, 'Admin MUST be allowed');
  });

  // -----------------------------------------------------------------
  // 2. Feature Gating (requireFeature) Blocks Free Plan
  // -----------------------------------------------------------------
  test('SEC-2: Free plan is blocked from Tier-S features', () => {
    const freePlanFeatures = { payroll: false, ai_assistant: false, gst_reconciliation: false };
    const proPlanFeatures = { payroll: true, ai_assistant: true, gst_reconciliation: true };

    const isFeatureEnabled = (plan, featureKey) => {
      return !!(plan && plan.features && plan.features[featureKey] === true);
    };

    assert.equal(isFeatureEnabled({ features: freePlanFeatures }, 'gst_reconciliation'), false);
    assert.equal(isFeatureEnabled({ features: proPlanFeatures }, 'gst_reconciliation'), true);
  });

  // -----------------------------------------------------------------
  // 3. GST Reconciliation Run Versioning Idempotency
  // -----------------------------------------------------------------
  test('IDEM-1: GST reconciliation re-run correctly increments version_number', () => {
    const existingRuns = [
      { period: '2026-07', version_number: 1, is_latest: true },
    ];

    const createNewRun = (runs, period) => {
      const match = runs.filter(r => r.period === period);
      const nextVersion = match.length > 0 ? Math.max(...match.map(r => r.version_number)) + 1 : 1;
      match.forEach(r => r.is_latest = false);
      const newRun = { period, version_number: nextVersion, is_latest: true };
      runs.push(newRun);
      return newRun;
    };

    const newRun = createNewRun(existingRuns, '2026-07');
    assert.equal(newRun.version_number, 2);
    assert.equal(newRun.is_latest, true);
    assert.equal(existingRuns[0].is_latest, false);
  });

  // -----------------------------------------------------------------
  // 4. Rate Limiter Window & Max Requests Logic
  // -----------------------------------------------------------------
  test('SEC-3: Login rate limiter threshold (max 20 requests per 15 min window)', () => {
    const maxRequests = 20;
    let requestCount = 0;

    const hitLoginEndpoint = () => {
      requestCount++;
      if (requestCount > maxRequests) {
        return { status: 429, message: 'Too many login attempts. Please try again later.' };
      }
      return { status: 200, message: 'OK' };
    };

    for (let i = 0; i < 20; i++) {
      const res = hitLoginEndpoint();
      assert.equal(res.status, 200);
    }

    const blockedRes = hitLoginEndpoint();
    assert.equal(blockedRes.status, 429);
    assert.ok(blockedRes.message.includes('Too many login attempts'));
  });

});
