/**
 * SmartERP Unit Tests
 * Tests critical business logic: payroll calculation, auth helpers, permissions
 * 
 * Run: npm test
 * Framework: Node.js built-in test runner (Node 18+ — no extra dependencies needed)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ─── Payroll Calculation Logic ────────────────────────────────────────────────
// Extracted from routes/payroll.js for unit testing
function calculateTotalSalary({ base_salary, extra_amount = 0, salary_increment = 0, deduction = 0 }) {
  return parseFloat(base_salary) +
    parseFloat(extra_amount) +
    parseFloat(salary_increment) -
    parseFloat(deduction);
}

describe('Payroll Calculation', () => {
  test('base + extra + increment = correct total', () => {
    const result = calculateTotalSalary({
      base_salary: 20000,
      extra_amount: 1000,
      salary_increment: 500,
      deduction: 0
    });
    assert.equal(result, 21500);
  });

  test('deduction is subtracted correctly', () => {
    const result = calculateTotalSalary({
      base_salary: 20000,
      extra_amount: 1000,
      salary_increment: 0,
      deduction: 500
    });
    assert.equal(result, 20500);
  });

  test('zero extra and increment returns base salary', () => {
    const result = calculateTotalSalary({
      base_salary: 15000,
      extra_amount: 0,
      salary_increment: 0,
      deduction: 0
    });
    assert.equal(result, 15000);
  });

  test('deduction larger than extras does not go negative unexpectedly', () => {
    const result = calculateTotalSalary({
      base_salary: 20000,
      extra_amount: 0,
      salary_increment: 0,
      deduction: 5000
    });
    assert.equal(result, 15000);
  });

  test('handles string inputs (as they come from API body)', () => {
    const result = calculateTotalSalary({
      base_salary: '20000',
      extra_amount: '1000',
      salary_increment: '500',
      deduction: '0'
    });
    assert.equal(result, 21500);
  });

  test('all zero values returns zero', () => {
    const result = calculateTotalSalary({
      base_salary: 0,
      extra_amount: 0,
      salary_increment: 0,
      deduction: 0
    });
    assert.equal(result, 0);
  });
});

// ─── JWT Token Logic ──────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const ACCESS_SECRET = 'test_secret_for_unit_tests';
const REFRESH_SECRET = 'test_refresh_secret_for_unit_tests';

function signAccessToken(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '1h' });
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

describe('JWT Auth Helpers', () => {
  test('signed token can be verified', () => {
    const payload = { id: 'user-123', role: 'owner', companyId: 1 };
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);
    assert.equal(decoded.id, 'user-123');
    assert.equal(decoded.role, 'owner');
    assert.equal(decoded.companyId, 1);
  });

  test('tampered token throws on verify', () => {
    const token = signAccessToken({ id: 'user-123' });
    const tampered = token + 'x';
    assert.throws(() => verifyAccessToken(tampered), /invalid signature|jwt malformed/i);
  });

  test('expired token throws JsonWebTokenError', () => {
    const expiredToken = jwt.sign({ id: 'user-123' }, ACCESS_SECRET, { expiresIn: '-1s' });
    assert.throws(() => verifyAccessToken(expiredToken), /jwt expired/i);
  });

  test('token signed with wrong secret throws', () => {
    const wrongToken = jwt.sign({ id: 'user-123' }, 'wrong_secret');
    assert.throws(() => verifyAccessToken(wrongToken), /invalid signature/i);
  });

  test('token payload includes all required fields', () => {
    const payload = { id: 'abc', userId: 'abc', role: 'employee', email: 'a@b.com', companyId: 5 };
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);
    assert.ok(decoded.id, 'id should be present');
    assert.ok(decoded.role, 'role should be present');
    assert.ok(decoded.companyId, 'companyId should be present');
  });
});

// ─── Role-Based Access Control Logic ─────────────────────────────────────────
function canAccessOwnerRoute(role) {
  return role === 'owner' || role === 'admin' || role === 'super_admin';
}

function canAccessEmployeeRoute(role) {
  return role === 'employee' || role === 'owner' || role === 'admin';
}

function canProcessPayroll(role) {
  return role === 'owner' || role === 'admin';
}

describe('Role-Based Access Control', () => {
  test('owner can access owner routes', () => {
    assert.equal(canAccessOwnerRoute('owner'), true);
  });

  test('employee cannot access owner routes', () => {
    assert.equal(canAccessOwnerRoute('employee'), false);
  });

  test('owner can access employee routes', () => {
    assert.equal(canAccessEmployeeRoute('owner'), true);
  });

  test('employee can access employee routes', () => {
    assert.equal(canAccessEmployeeRoute('employee'), true);
  });

  test('only owner/admin can process payroll', () => {
    assert.equal(canProcessPayroll('owner'), true);
    assert.equal(canProcessPayroll('admin'), true);
    assert.equal(canProcessPayroll('employee'), false);
  });

  test('unknown role cannot access any route', () => {
    assert.equal(canAccessOwnerRoute('unknown'), false);
    assert.equal(canAccessEmployeeRoute('unknown'), false);
    assert.equal(canProcessPayroll('unknown'), false);
  });
});

// ─── Subscription Feature Guard Logic ────────────────────────────────────────
function hasFeature(planFeatures, featureName) {
  if (!planFeatures || typeof planFeatures !== 'object') return false;
  return planFeatures[featureName] === true;
}

describe('Feature Guard (Subscription)', () => {
  const freePlan = { payroll: false, messages: false, location_tracking: false };
  const basicPlan = { payroll: true, messages: false, location_tracking: false };
  const proPlan = { payroll: true, messages: true, location_tracking: true };

  test('free plan cannot access payroll', () => {
    assert.equal(hasFeature(freePlan, 'payroll'), false);
  });

  test('basic plan can access payroll', () => {
    assert.equal(hasFeature(basicPlan, 'payroll'), true);
  });

  test('pro plan can access all features', () => {
    assert.equal(hasFeature(proPlan, 'payroll'), true);
    assert.equal(hasFeature(proPlan, 'messages'), true);
    assert.equal(hasFeature(proPlan, 'location_tracking'), true);
  });

  test('null plan features returns false', () => {
    assert.equal(hasFeature(null, 'payroll'), false);
    assert.equal(hasFeature(undefined, 'payroll'), false);
  });

  test('missing feature key returns false', () => {
    assert.equal(hasFeature(basicPlan, 'nonexistent_feature'), false);
  });
});
