const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyBiometricSignature, claimNonce } = require('../services/biometricWebhookAuth');

const request = (overrides = {}) => {
  const body = { device_id: 'device-1', employee_id: 'employee-1', action: 'clock_in', timestamp: '2026-10-17T03:30:00.000Z' };
  const now = Date.parse('2026-10-17T03:30:01.000Z');
  const signedAt = String(Math.floor(now / 1000));
  const nonce = '0123456789abcdef';
  const secret = 'test-secret-for-biometric-webhook';
  const signature = crypto.createHmac('sha256', secret).update(`${signedAt}.${nonce}.${JSON.stringify(body)}`).digest('hex');
  return { secret, signature, signedAt, nonce, body, now, ...overrides };
};

test('valid signed biometric body verifies in constant time and returns nonce', () => {
  const result = verifyBiometricSignature(request());
  assert.deepEqual(result, { valid: true, nonce: '0123456789abcdef' });
});

test('missing secret, changed body, malformed nonce and stale signature are rejected', () => {
  assert.equal(verifyBiometricSignature(request({ secret: '' })).reason, 'not_configured');
  const altered = request(); altered.body.action = 'clock_out';
  assert.equal(verifyBiometricSignature(altered).reason, 'signature');
  assert.equal(verifyBiometricSignature(request({ nonce: 'short' })).reason, 'malformed');
  assert.equal(verifyBiometricSignature(request({ now: Date.parse('2026-10-17T03:40:00.000Z') })).reason, 'expired');
});

test('nonce claim is atomic and rejects replays', async () => {
  const claimed = new Set();
  const redis = { status: 'ready', async set(key, value, nx, ex, ttl) {
    assert.equal(nx, 'NX'); assert.equal(ex, 'EX'); assert.equal(ttl, 600);
    if (claimed.has(key)) return null;
    claimed.add(key); return 'OK';
  } };
  assert.equal(await claimNonce(redis, '0123456789abcdef'), 'claimed');
  assert.equal(await claimNonce(redis, '0123456789abcdef'), 'replayed');
  assert.equal(await claimNonce({ status: 'end' }, 'nonce'), 'unavailable');
});
