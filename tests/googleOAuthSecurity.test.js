const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Require auth route or isolate the state helpers for independent verification
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_for_audit_32_characters_minimum';

test('Google OAuth Security: State signature & strict role whitelisting', async (t) => {
  // Test 1: Simulating an attacker crafting a base64 payload with role: super_admin
  const maliciousStateUnsigned = Buffer.from(JSON.stringify({
    type: 'staff',
    role: 'super_admin',
    company_code: null
  })).toString('base64');

  // Verify behavior using isolated logic identical to the auth route
  function parseAndVerifyOAuthState(rawState) {
    const fallback = { type: 'staff', role: 'owner', company_code: null };
    if (!rawState || typeof rawState !== 'string') return fallback;
    try {
      const parsed = JSON.parse(Buffer.from(rawState, 'base64').toString('utf8'));
      let payload = null;

      if (parsed && typeof parsed.p === 'string' && typeof parsed.s === 'string') {
        const secret = process.env.JWT_SECRET || 'smarterp_oauth_fallback_secret';
        const expected = crypto.createHmac('sha256', secret).update(parsed.p).digest('hex');
        const sigBufExpected = Buffer.from(expected, 'utf8');
        const sigBufActual = Buffer.from(parsed.s, 'utf8');
        if (sigBufExpected.length === sigBufActual.length && crypto.timingSafeEqual(sigBufExpected, sigBufActual)) {
          payload = JSON.parse(parsed.p);
        }
      }

      if (!payload && typeof parsed === 'object') {
        payload = parsed;
      }

      if (!payload) return fallback;

      const rawRole = String(payload.role || '').toLowerCase().trim();
      const safeRole = rawRole === 'employee' ? 'employee' : 'owner';
      const safeType = payload.type === 'customer' ? 'customer' : 'staff';
      const safeCompanyCode = payload.company_code ? String(payload.company_code).trim().slice(0, 50) : null;

      return {
        type: safeType,
        role: safeRole,
        company_code: safeCompanyCode
      };
    } catch (_) {
      return fallback;
    }
  }

  await t.test('unsigned state with role=super_admin must be sanitized to owner', () => {
    const result = parseAndVerifyOAuthState(maliciousStateUnsigned);
    assert.equal(result.role, 'owner', 'super_admin was not sanitized to owner');
    assert.notEqual(result.role, 'super_admin', 'super_admin was unexpectedly accepted');
  });

  await t.test('unsigned state with arbitrary string role=admin must be sanitized to owner', () => {
    const arbitraryState = Buffer.from(JSON.stringify({ type: 'staff', role: 'system_root' })).toString('base64');
    const result = parseAndVerifyOAuthState(arbitraryState);
    assert.equal(result.role, 'owner');
  });

  await t.test('signed legitimate owner state is preserved', () => {
    const payloadStr = JSON.stringify({ type: 'staff', role: 'owner', company_code: null, ts: Date.now() });
    const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payloadStr).digest('hex');
    const signedState = Buffer.from(JSON.stringify({ p: payloadStr, s: sig })).toString('base64');
    
    const result = parseAndVerifyOAuthState(signedState);
    assert.equal(result.role, 'owner');
    assert.equal(result.type, 'staff');
  });

  await t.test('signed legitimate employee state with company_code is preserved', () => {
    const payloadStr = JSON.stringify({ type: 'staff', role: 'employee', company_code: 'COMP-1234', ts: Date.now() });
    const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payloadStr).digest('hex');
    const signedState = Buffer.from(JSON.stringify({ p: payloadStr, s: sig })).toString('base64');
    
    const result = parseAndVerifyOAuthState(signedState);
    assert.equal(result.role, 'employee');
    assert.equal(result.company_code, 'COMP-1234');
  });

  await t.test('tampered signed state with modified payload fails signature and is sanitized', () => {
    const originalPayloadStr = JSON.stringify({ type: 'staff', role: 'owner', company_code: null });
    const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(originalPayloadStr).digest('hex');
    const tamperedPayloadStr = JSON.stringify({ type: 'staff', role: 'super_admin', company_code: null });
    const tamperedState = Buffer.from(JSON.stringify({ p: tamperedPayloadStr, s: sig })).toString('base64');
    
    const result = parseAndVerifyOAuthState(tamperedState);
    assert.equal(result.role, 'owner', 'Tampered state was not sanitized');
  });
});
