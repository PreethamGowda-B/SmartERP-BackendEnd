const crypto = require('crypto');

function isWebhookEnabled(value, contractVerified) {
  return String(value || '').toLowerCase() === 'true' && String(contractVerified || '').toLowerCase() === 'true';
}

function verifyBiometricSignature({ secret, signature, signedAt, nonce, body, now = Date.now() }) {
  if (!secret) return { valid: false, reason: 'not_configured' };
  const cleanSignature = String(signature || '').replace(/^sha256=/i, '').toLowerCase();
  const timestamp = String(signedAt || '');
  const requestNonce = String(nonce || '');
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestNonce) || !/^[a-f0-9]{64}$/.test(cleanSignature)) {
    return { valid: false, reason: 'malformed' };
  }
  const signedAtMs = Number(timestamp.length === 13 ? timestamp : `${timestamp}000`);
  if (Math.abs(now - signedAtMs) > 5 * 60 * 1000) return { valid: false, reason: 'expired' };
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${requestNonce}.${JSON.stringify(body)}`).digest();
  const supplied = Buffer.from(cleanSignature, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return { valid: false, reason: 'signature' };
  return { valid: true, nonce: requestNonce };
}

async function claimNonce(redisClient, nonce) {
  if (!redisClient || redisClient.status !== 'ready') return 'unavailable';
  const result = await redisClient.set(`biometric_nonce:${nonce}`, '1', 'NX', 'EX', 600);
  return result === 'OK' ? 'claimed' : 'replayed';
}

module.exports = { verifyBiometricSignature, claimNonce, isWebhookEnabled };
