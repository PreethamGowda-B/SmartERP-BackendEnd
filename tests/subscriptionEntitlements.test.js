const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SUBSCRIPTION_PLANS, applyCanonicalPlanFeatures } = require('../services/subscriptionCatalog');
const { requireFeature } = require('../middleware/featureGuard');

const migrationSql = fs.readFileSync(path.join(__dirname, '../migrations/037_subscription_catalog_and_storage.sql'), 'utf8');

const expectedFeatures = {
  1: {
    payroll: false, messages: true, ai_assistant: false, basic_reports: true,
    export_reports: true, advanced_reports: false, inventory_images: false,
    priority_support: false, location_tracking: false, ar_collections: false,
    inventory_forecasts: false,
  },
  2: {
    payroll: true, messages: true, ai_assistant: true, basic_reports: true,
    export_reports: true, advanced_reports: true, inventory_images: true,
    priority_support: false, location_tracking: true, ar_collections: true,
    inventory_forecasts: true,
  },
  3: {
    payroll: true, messages: true, ai_assistant: true, basic_reports: true,
    export_reports: true, advanced_reports: true, inventory_images: true,
    priority_support: false, location_tracking: true, ar_collections: true,
    inventory_forecasts: true,
  },
};

function runFeatureGuard(features, feature) {
  const result = { status: null, body: null, nextCalled: false };
  const res = {
    status(status) { result.status = status; return this; },
    json(body) { result.body = body; return this; },
  };
  requireFeature(feature, feature)({ plan: { id: 1, name: 'Starter', features }, user: { role: 'owner' } }, res, () => {
    result.nextCalled = true;
  });
  return result;
}

test('catalog and migration 037 define identical plan feature assignments', () => {
  for (const [id, expected] of Object.entries(expectedFeatures)) {
    assert.deepEqual(SUBSCRIPTION_PLANS[id].features, expected);
    assert.ok(migrationSql.includes(`'${JSON.stringify(expected)}'::jsonb`), `migration 037 must seed plan ${id} feature flags`);
  }
  assert.equal(SUBSCRIPTION_PLANS[2].features.priority_support, false);
  assert.equal(SUBSCRIPTION_PLANS[3].features.priority_support, false);
});

test('Starter, Professional, Enterprise and the Enterprise trial use their assigned gates', () => {
  for (const [id, plan] of Object.entries(SUBSCRIPTION_PLANS)) {
    assert.deepEqual(plan.features, expectedFeatures[id]);
    for (const [feature, expected] of Object.entries(expectedFeatures[id])) {
      const result = runFeatureGuard(plan.features, feature);
      assert.equal(result.nextCalled, expected, `plan ${id} ${feature} access`);
      assert.equal(result.status, expected ? null : 403, `plan ${id} ${feature} denial`);
    }
  }

  const starterDenied = runFeatureGuard(SUBSCRIPTION_PLANS[1].features, 'payroll');
  assert.equal(starterDenied.status, 403);
  assert.equal(starterDenied.nextCalled, false);

  for (const id of [2, 3]) {
    const paidAllowed = runFeatureGuard(SUBSCRIPTION_PLANS[id].features, 'payroll');
    assert.equal(paidAllowed.nextCalled, true);
    assert.equal(paidAllowed.status, null);
  }

  // Trial entitlement resolves to plan ID 3 in loadPlan; it receives the same
  // feature set as Enterprise, with a separate trial expiry state.
  const trialPlan = { ...SUBSCRIPTION_PLANS[3], id: 3, is_trial: true };
  for (const [feature, expected] of Object.entries(expectedFeatures[3])) {
    assert.equal(runFeatureGuard(trialPlan.features, feature).nextCalled, expected, `trial ${feature} access`);
  }
});

test('cached plan feature JSON is normalized to the backend catalog before use', () => {
  for (const [id, features] of Object.entries(expectedFeatures)) {
    const normalized = applyCanonicalPlanFeatures({ id: Number(id), name: 'stale database label', features: { payroll: true, priority_support: true } });
    assert.equal(normalized.name, SUBSCRIPTION_PLANS[id].name);
    assert.deepEqual(normalized.features, features);
  }
  assert.equal(applyCanonicalPlanFeatures({ id: 99, features: { payroll: true } }).features.payroll, true);
});

test('enabled basic report and export flags pass; disabled and missing flags fail closed', () => {
  for (const feature of ['basic_reports', 'export_reports']) {
    for (const id of [1, 2, 3]) {
      assert.equal(runFeatureGuard(SUBSCRIPTION_PLANS[id].features, feature).nextCalled, true);
    }
    assert.equal(runFeatureGuard({ [feature]: false }, feature).status, 403);
    assert.equal(runFeatureGuard({}, feature).status, 403);
  }
});

test('report, export, and every location API route wire the server entitlement guard', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const reports = read('routes/reports.js');
  const analytics = read('routes/analytics.js');
  const customerReports = read('routes/customerReports.js');
  const exportRoutes = read('routes/export.js');
  const location = read('routes/location.js');
  const customerJobs = read('routes/customer/jobs.js');
  const attendance = read('routes/attendance.js');
  const hr = read('routes/hr.js');

  for (const endpoint of ['my-attendance', 'my-jobs', 'my-materials']) {
    assert.match(reports, new RegExp(`router\\.get\\('/${endpoint}'.*requireFeature\\('basic_reports'`));
  }
  assert.match(analytics, /router\.get\('\/summary'.*requireFeature\('basic_reports'/);
  assert.match(customerReports, /router\.get\('\/'.*requireFeature\('basic_reports'/);
  assert.match(attendance, /router\.get\('\/report'.*requireFeature\('basic_reports'/);
  assert.match(hr, /router\.get\('\/analytics'.*requireFeature\('basic_reports'/);
  assert.match(exportRoutes, /router\.get\('\/company-backup'.*requireFeature\('export_reports'/);

  assert.match(location, /router\.post\('\/update'.*requireFeature\('location_tracking'/);
  assert.match(location, /router\.get\('\/all'.*requireFeature\('location_tracking'/);
  assert.match(location, /router\.get\('\/:employeeId'.*requireFeature\('location_tracking'/);
  assert.match(customerJobs, /router\.get\('\/:id\/tracking'.*loadPlan, requireFeature\('location_tracking'/);
});
