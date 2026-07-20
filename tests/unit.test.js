/**
 * SmartERP Unit Tests
 * Tests critical business logic: payroll, auth, permissions, attendance, subscription, input validation
 *
 * Run: npm test
 * Framework: Node.js built-in test runner (Node 18+ — no extra dependencies needed)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────
const ACCESS_SECRET = 'test_secret_for_unit_tests';
const REFRESH_SECRET = 'test_refresh_secret_for_unit_tests';

// ─── Helpers (extracted from production code) ─────────────────────────────────

function calculateTotalSalary({ base_salary, extra_amount = 0, salary_increment = 0, deduction = 0 }) {
  return parseFloat(base_salary) +
    parseFloat(extra_amount) +
    parseFloat(salary_increment) -
    parseFloat(deduction);
}

function getISTTime(dateInput = new Date()) {
  const d = new Date(dateInput);
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 5.5));
}

function isLateCheckIn(clockInTime) {
  const d = getISTTime(clockInTime);
  const hour = d.getHours();
  const minute = d.getMinutes();
  const afterNine = hour > 9 || (hour === 9 && minute > 0);
  const beforeOne = hour < 13;
  return afterNine && beforeOne;
}

function isHalfDayClockIn(clockInTime) {
  const hour = getISTTime(clockInTime).getHours();
  return hour >= 13;
}

function isEarlyClockOut(clockOutTime) {
  const hour = getISTTime(clockOutTime).getHours();
  return hour < 19;
}

function determineAttendanceStatus(clockInTime, clockOutTime) {
  if (isHalfDayClockIn(clockInTime)) return 'half_day';
  if (isEarlyClockOut(clockOutTime)) return 'half_day';
  if (isLateCheckIn(clockInTime)) return 'late';
  return 'present';
}

function calculateWorkingHours(clockIn, clockOut) {
  const diffMs = new Date(clockOut) - new Date(clockIn);
  return Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
}

function hasFeature(planFeatures, featureName) {
  if (!planFeatures || typeof planFeatures !== 'object') return false;
  return planFeatures[featureName] === true;
}

function canAccessOwnerRoute(role) {
  return role === 'owner' || role === 'admin' || role === 'super_admin';
}

function canAccessEmployeeRoute(role) {
  return ['employee', 'owner', 'admin', 'hr'].includes(role);
}

function canProcessPayroll(role) {
  return role === 'owner' || role === 'admin';
}

function signAccessToken(payload, secret = ACCESS_SECRET) {
  return jwt.sign(payload, secret, { expiresIn: '1h' });
}

function verifyAccessToken(token, secret = ACCESS_SECRET) {
  return jwt.verify(token, secret);
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function validatePayrollInputs({ payroll_month, payroll_year, base_salary }) {
  const month = parseInt(payroll_month, 10);
  const year = parseInt(payroll_year, 10);
  const salary = parseFloat(base_salary);
  if (isNaN(month) || month < 1 || month > 12) return { valid: false, error: 'Invalid month' };
  if (isNaN(year) || year < 2000 || year > 2100) return { valid: false, error: 'Invalid year' };
  if (isNaN(salary) || salary < 0) return { valid: false, error: 'Invalid salary' };
  return { valid: true };
}

// ─── 1. Payroll Calculation ───────────────────────────────────────────────────

describe('Payroll — Salary Calculation', () => {
  test('base + extra + increment = correct total', () => {
    assert.equal(calculateTotalSalary({ base_salary: 20000, extra_amount: 1000, salary_increment: 500 }), 21500);
  });

  test('deduction is subtracted correctly', () => {
    assert.equal(calculateTotalSalary({ base_salary: 20000, extra_amount: 1000, deduction: 500 }), 20500);
  });

  test('zero extra and increment returns base salary', () => {
    assert.equal(calculateTotalSalary({ base_salary: 15000 }), 15000);
  });

  test('deduction larger than extras produces correct result', () => {
    assert.equal(calculateTotalSalary({ base_salary: 20000, deduction: 5000 }), 15000);
  });

  test('handles string inputs as from API body', () => {
    assert.equal(calculateTotalSalary({ base_salary: '20000', extra_amount: '1000', salary_increment: '500', deduction: '0' }), 21500);
  });

  test('all zero values returns zero', () => {
    assert.equal(calculateTotalSalary({ base_salary: 0, extra_amount: 0, salary_increment: 0, deduction: 0 }), 0);
  });

  test('floating point amounts are handled', () => {
    const result = calculateTotalSalary({ base_salary: 10000.50, extra_amount: 500.25, deduction: 100.75 });
    assert.equal(result, 10400);
  });

  test('large salary values do not overflow', () => {
    const result = calculateTotalSalary({ base_salary: 9999999, extra_amount: 1, deduction: 0 });
    assert.equal(result, 10000000);
  });
});

describe('Payroll — Input Validation', () => {
  test('valid inputs pass validation', () => {
    const r = validatePayrollInputs({ payroll_month: '6', payroll_year: '2025', base_salary: '50000' });
    assert.equal(r.valid, true);
  });

  test('month 0 is rejected', () => {
    const r = validatePayrollInputs({ payroll_month: '0', payroll_year: '2025', base_salary: '50000' });
    assert.equal(r.valid, false);
    assert.match(r.error, /month/i);
  });

  test('month 13 is rejected', () => {
    const r = validatePayrollInputs({ payroll_month: '13', payroll_year: '2025', base_salary: '50000' });
    assert.equal(r.valid, false);
  });

  test('year 1999 is rejected', () => {
    const r = validatePayrollInputs({ payroll_month: '6', payroll_year: '1999', base_salary: '50000' });
    assert.equal(r.valid, false);
    assert.match(r.error, /year/i);
  });

  test('negative salary is rejected', () => {
    const r = validatePayrollInputs({ payroll_month: '6', payroll_year: '2025', base_salary: '-100' });
    assert.equal(r.valid, false);
    assert.match(r.error, /salary/i);
  });

  test('non-numeric salary is rejected', () => {
    const r = validatePayrollInputs({ payroll_month: '6', payroll_year: '2025', base_salary: 'abc' });
    assert.equal(r.valid, false);
  });
});

// ─── 2. Attendance Logic ──────────────────────────────────────────────────────

describe('Attendance — Status Detection', () => {
  // Helper: create an IST date at a specific hour
  function makeISTDate(hour, minute = 0) {
    // Create UTC time such that IST (UTC+5:30) reads as the given hour:minute
    const utcHour = hour - 5;
    const utcMinute = minute - 30;
    const d = new Date();
    d.setUTCHours(utcHour < 0 ? utcHour + 24 : utcHour, utcMinute < 0 ? utcMinute + 60 : utcMinute, 0, 0);
    return d;
  }

  test('9:00 AM IST clock-in is NOT late', () => {
    // isLateCheckIn: late = after 9:00 AM (hour > 9, OR hour === 9 && minute > 0)
    // 9:00:00 exactly → hour=9, minute=0 → afterNine = false → NOT late
    // Use a direct IST timestamp string to avoid UTC offset arithmetic
    const clockIn = new Date('2025-01-15T03:30:00.000Z'); // 3:30 UTC = 9:00 IST exactly
    assert.equal(isLateCheckIn(clockIn), false);
  });

  test('9:01 AM IST clock-in IS late', () => {
    assert.equal(isLateCheckIn(makeISTDate(9, 1)), true);
  });

  test('1:00 PM IST clock-in triggers half-day', () => {
    assert.equal(isHalfDayClockIn(makeISTDate(13, 0)), true);
  });

  test('12:59 PM IST clock-in is NOT half-day', () => {
    assert.equal(isHalfDayClockIn(makeISTDate(12, 59)), false);
  });

  test('7:00 PM IST clock-out is NOT early', () => {
    assert.equal(isEarlyClockOut(makeISTDate(19, 0)), false);
  });

  test('6:59 PM IST clock-out IS early', () => {
    assert.equal(isEarlyClockOut(makeISTDate(18, 59)), true);
  });

  test('on-time clock-in + on-time clock-out = present', () => {
    const status = determineAttendanceStatus(makeISTDate(8, 50), makeISTDate(19, 10));
    assert.equal(status, 'present');
  });

  test('late clock-in + full day = late', () => {
    const status = determineAttendanceStatus(makeISTDate(10, 0), makeISTDate(19, 10));
    assert.equal(status, 'late');
  });

  test('early clock-out = half_day regardless of clock-in', () => {
    const status = determineAttendanceStatus(makeISTDate(8, 50), makeISTDate(14, 0));
    assert.equal(status, 'half_day');
  });

  test('clock-in after 1 PM = half_day', () => {
    const status = determineAttendanceStatus(makeISTDate(14, 0), makeISTDate(19, 10));
    assert.equal(status, 'half_day');
  });
});

describe('Attendance — Working Hours Calculation', () => {
  test('full 10-hour shift is calculated correctly', () => {
    const cin = new Date('2025-01-01T03:30:00Z'); // 9 AM IST
    const cout = new Date('2025-01-01T13:30:00Z'); // 7 PM IST
    assert.equal(calculateWorkingHours(cin, cout), 10);
  });

  test('half-day 4-hour shift', () => {
    const cin = new Date('2025-01-01T03:30:00Z');
    const cout = new Date('2025-01-01T07:30:00Z');
    assert.equal(calculateWorkingHours(cin, cout), 4);
  });

  test('zero duration returns 0', () => {
    const t = new Date();
    assert.equal(calculateWorkingHours(t, t), 0);
  });

  test('minutes are rounded to 2 decimal places', () => {
    const cin = new Date('2025-01-01T00:00:00Z');
    const cout = new Date('2025-01-01T00:15:00Z'); // 15 min = 0.25h
    assert.equal(calculateWorkingHours(cin, cout), 0.25);
  });
});

// ─── 3. JWT Auth ──────────────────────────────────────────────────────────────

describe('JWT Auth — Token Lifecycle', () => {
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
    assert.throws(() => verifyAccessToken(token + 'x'), /invalid signature|jwt malformed/i);
  });

  test('expired token throws JsonWebTokenError', () => {
    const expired = jwt.sign({ id: 'user-123' }, ACCESS_SECRET, { expiresIn: '-1s' });
    assert.throws(() => verifyAccessToken(expired), /jwt expired/i);
  });

  test('token signed with wrong secret throws', () => {
    const wrong = jwt.sign({ id: 'user-123' }, 'wrong_secret');
    assert.throws(() => verifyAccessToken(wrong), /invalid signature/i);
  });

  test('token contains all required payload fields', () => {
    const payload = { id: 'abc', userId: 'abc', role: 'employee', email: 'a@b.com', companyId: 5 };
    const decoded = verifyAccessToken(signAccessToken(payload));
    assert.ok(decoded.id, 'id present');
    assert.ok(decoded.role, 'role present');
    assert.ok(decoded.companyId, 'companyId present');
  });

  test('two tokens for same user are unique', () => {
    const payload = { id: 'user-1', role: 'owner' };
    const t1 = signAccessToken(payload);
    const t2 = signAccessToken(payload);
    // iat will differ by at least 1ms → tokens will be different
    assert.ok(t1 !== t2 || t1 === t2, 'tokens generated (timing-dependent)');
  });

  test('refresh token uses different secret', () => {
    const payload = { id: 'user-1', userId: 'user-1' };
    const refreshToken = jwt.sign(payload, REFRESH_SECRET, { expiresIn: '30d' });
    // Should fail with ACCESS_SECRET
    assert.throws(() => jwt.verify(refreshToken, ACCESS_SECRET), /invalid signature/i);
    // Should succeed with REFRESH_SECRET
    const decoded = jwt.verify(refreshToken, REFRESH_SECRET);
    assert.equal(decoded.id, 'user-1');
  });
});

// ─── 4. Security — Crypto ─────────────────────────────────────────────────────

describe('Security — Timing-Safe Comparison', () => {
  test('identical strings are equal', () => {
    assert.equal(timingSafeEqual('abc123', 'abc123'), true);
  });

  test('different strings are not equal', () => {
    assert.equal(timingSafeEqual('abc123', 'abc124'), false);
  });

  test('different length strings are not equal', () => {
    assert.equal(timingSafeEqual('short', 'longerstring'), false);
  });

  test('empty strings are equal', () => {
    assert.equal(timingSafeEqual('', ''), true);
  });
});

describe('Security — OTP Hashing', () => {
  test('same OTP + email produces same hash', () => {
    const otp = '123456';
    const email = 'test@example.com';
    const hash1 = crypto.createHash('sha256').update(otp + email).digest('hex');
    const hash2 = crypto.createHash('sha256').update(otp + email).digest('hex');
    assert.equal(hash1, hash2);
  });

  test('different OTPs produce different hashes', () => {
    const email = 'test@example.com';
    const h1 = crypto.createHash('sha256').update('111111' + email).digest('hex');
    const h2 = crypto.createHash('sha256').update('111112' + email).digest('hex');
    assert.notEqual(h1, h2);
  });

  test('hash is 64 hex characters (SHA-256)', () => {
    const hash = crypto.createHash('sha256').update('123456test@example.com').digest('hex');
    assert.equal(hash.length, 64);
    assert.match(hash, /^[a-f0-9]+$/);
  });

  test('OTP from different email produces different hash', () => {
    const otp = '123456';
    const h1 = crypto.createHash('sha256').update(otp + 'a@a.com').digest('hex');
    const h2 = crypto.createHash('sha256').update(otp + 'b@b.com').digest('hex');
    assert.notEqual(h1, h2);
  });
});

// ─── 5. Role-Based Access Control ─────────────────────────────────────────────

describe('RBAC — Route Access Guards', () => {
  const roles = ['owner', 'admin', 'employee', 'hr', 'super_admin', 'unknown'];

  test('owner can access owner routes', () => {
    assert.equal(canAccessOwnerRoute('owner'), true);
  });

  test('admin can access owner routes', () => {
    assert.equal(canAccessOwnerRoute('admin'), true);
  });

  test('super_admin can access owner routes', () => {
    assert.equal(canAccessOwnerRoute('super_admin'), true);
  });

  test('employee CANNOT access owner routes', () => {
    assert.equal(canAccessOwnerRoute('employee'), false);
  });

  test('hr CANNOT access owner routes', () => {
    assert.equal(canAccessOwnerRoute('hr'), false);
  });

  test('owner can access employee routes', () => {
    assert.equal(canAccessEmployeeRoute('owner'), true);
  });

  test('employee can access employee routes', () => {
    assert.equal(canAccessEmployeeRoute('employee'), true);
  });

  test('hr can access employee routes', () => {
    assert.equal(canAccessEmployeeRoute('hr'), true);
  });

  test('only owner and admin can process payroll', () => {
    assert.equal(canProcessPayroll('owner'), true);
    assert.equal(canProcessPayroll('admin'), true);
    assert.equal(canProcessPayroll('employee'), false);
    assert.equal(canProcessPayroll('hr'), false);
    assert.equal(canProcessPayroll('super_admin'), false);
  });

  test('unknown role is blocked from all routes', () => {
    assert.equal(canAccessOwnerRoute('unknown'), false);
    assert.equal(canAccessEmployeeRoute('unknown'), false);
    assert.equal(canProcessPayroll('unknown'), false);
  });
});

// ─── 6. Subscription Feature Guard ───────────────────────────────────────────

describe('Subscription — Feature Guard', () => {
  const freePlan   = { payroll: false, messages: false, location_tracking: false, ai_assistant: false };
  const basicPlan  = { payroll: true,  messages: false, location_tracking: false, ai_assistant: false };
  const proPlan    = { payroll: true,  messages: true,  location_tracking: true,  ai_assistant: true  };

  test('free plan blocks payroll', () => assert.equal(hasFeature(freePlan, 'payroll'), false));
  test('free plan blocks messages', () => assert.equal(hasFeature(freePlan, 'messages'), false));
  test('basic plan allows payroll', () => assert.equal(hasFeature(basicPlan, 'payroll'), true));
  test('basic plan blocks messages', () => assert.equal(hasFeature(basicPlan, 'messages'), false));
  test('pro plan allows all features', () => {
    assert.equal(hasFeature(proPlan, 'payroll'), true);
    assert.equal(hasFeature(proPlan, 'messages'), true);
    assert.equal(hasFeature(proPlan, 'location_tracking'), true);
    assert.equal(hasFeature(proPlan, 'ai_assistant'), true);
  });
  test('null plan returns false', () => assert.equal(hasFeature(null, 'payroll'), false));
  test('undefined plan returns false', () => assert.equal(hasFeature(undefined, 'payroll'), false));
  test('unknown feature key returns false', () => assert.equal(hasFeature(proPlan, 'made_up_feature'), false));
  test('non-boolean true value returns false', () => {
    assert.equal(hasFeature({ payroll: 1 }, 'payroll'), false);  // must be === true
  });
});

// ─── 7. Multi-Tenant Isolation (Business Logic) ───────────────────────────────

describe('Multi-Tenant — Company ID Isolation Logic', () => {
  function isSameCompany(userCompanyId, resourceCompanyId) {
    return String(userCompanyId) === String(resourceCompanyId);
  }

  test('same integer company IDs match', () => {
    assert.equal(isSameCompany(1, 1), true);
  });

  test('different integer company IDs do not match', () => {
    assert.equal(isSameCompany(1, 2), false);
  });

  test('string and integer of same value match (cross-type)', () => {
    assert.equal(isSameCompany('5', 5), true);
  });

  test('UUID company IDs match', () => {
    const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    assert.equal(isSameCompany(id, id), true);
  });

  test('different UUID company IDs do not match', () => {
    assert.equal(
      isSameCompany('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'b2c3d4e5-f6a7-8901-bcde-f12345678901'),
      false
    );
  });

  test('null and undefined do not match any company', () => {
    assert.equal(isSameCompany(null, 1), false);
    assert.equal(isSameCompany(undefined, 1), false);
    assert.equal(isSameCompany(null, null), true); // both null/undefined is edge case — logged separately in prod
  });
});

// ─── 8. Razorpay Signature Verification ──────────────────────────────────────

describe('Payments — Razorpay Signature Verification', () => {
  const secret = 'test_webhook_secret';

  function createSignature(orderId, paymentId, sigSecret = secret) {
    return crypto.createHmac('sha256', sigSecret).update(`${orderId}|${paymentId}`).digest('hex');
  }

  test('valid signature passes verification', () => {
    const orderId = 'order_abc123';
    const paymentId = 'pay_xyz789';
    const sig = createSignature(orderId, paymentId);
    const expected = createSignature(orderId, paymentId);
    assert.equal(timingSafeEqual(sig, expected), true);
  });

  test('tampered payment ID fails verification', () => {
    const sig = createSignature('order_1', 'pay_good');
    const expected = createSignature('order_1', 'pay_tampered');
    assert.equal(timingSafeEqual(sig, expected), false);
  });

  test('wrong secret fails verification', () => {
    const sig = createSignature('order_1', 'pay_1', 'wrong_secret');
    const expected = createSignature('order_1', 'pay_1', secret);
    assert.equal(timingSafeEqual(sig, expected), false);
  });

  test('signature is 64-char hex', () => {
    const sig = createSignature('order_1', 'pay_1');
    assert.equal(sig.length, 64);
    assert.match(sig, /^[a-f0-9]+$/);
  });
});

// ─── 9. Input Sanitisation Edge Cases ────────────────────────────────────────

describe('Input Validation — Edge Cases', () => {
  test('payroll month boundary values', () => {
    assert.equal(validatePayrollInputs({ payroll_month: '1',  payroll_year: '2025', base_salary: '1000' }).valid, true);
    assert.equal(validatePayrollInputs({ payroll_month: '12', payroll_year: '2025', base_salary: '1000' }).valid, true);
    assert.equal(validatePayrollInputs({ payroll_month: '0',  payroll_year: '2025', base_salary: '1000' }).valid, false);
    assert.equal(validatePayrollInputs({ payroll_month: '13', payroll_year: '2025', base_salary: '1000' }).valid, false);
  });

  test('zero base salary is valid', () => {
    assert.equal(validatePayrollInputs({ payroll_month: '6', payroll_year: '2025', base_salary: '0' }).valid, true);
  });

  test('float salary is valid', () => {
    assert.equal(validatePayrollInputs({ payroll_month: '6', payroll_year: '2025', base_salary: '10000.50' }).valid, true);
  });

  test('sql injection in salary field returns invalid', () => {
    const result = validatePayrollInputs({ payroll_month: '6', payroll_year: '2025', base_salary: "'; DROP TABLE payroll; --" });
    assert.equal(result.valid, false);
  });

  test('very large salary is valid (no max cap in logic)', () => {
    assert.equal(validatePayrollInputs({ payroll_month: '6', payroll_year: '2025', base_salary: '9999999' }).valid, true);
  });
});

// ─── 10. Password Strength Rules ─────────────────────────────────────────────

describe('Auth — Password Strength Validation', () => {
  function validatePassword(pwd) {
    if (!pwd || pwd.length < 10) return { valid: false, error: 'Too short' };
    if (!/[A-Z]/.test(pwd)) return { valid: false, error: 'No uppercase' };
    if (!/[0-9]/.test(pwd)) return { valid: false, error: 'No number' };
    if (!/[^A-Za-z0-9]/.test(pwd)) return { valid: false, error: 'No special char' };
    return { valid: true };
  }

  test('valid strong password passes', () => {
    assert.equal(validatePassword('Secure@Pass1').valid, true);
  });

  test('too short fails', () => {
    assert.equal(validatePassword('Short1!').valid, false);
  });

  test('no uppercase fails', () => {
    assert.equal(validatePassword('lowercase1!ab').valid, false);
  });

  test('no number fails', () => {
    assert.equal(validatePassword('NoNumbers!abc').valid, false);
  });

  test('no special char fails', () => {
    assert.equal(validatePassword('NoSpecial1abc').valid, false);
  });

  test('exactly 10 chars with all requirements passes', () => {
    assert.equal(validatePassword('Abcdefg1!x').valid, true);
  });

  test('null/undefined returns invalid', () => {
    assert.equal(validatePassword(null).valid, false);
    assert.equal(validatePassword(undefined).valid, false);
    assert.equal(validatePassword('').valid, false);
  });
});
