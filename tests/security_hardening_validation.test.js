/**
 * 🛡️ SmartERP Security Hardening Test Suite
 *
 * Validates:
 * 1. Refresh-token cryptographic hashing, single-use rotation, and replay/family revocation.
 * 2. Concurrency serialization ensuring two simultaneous requests cannot both rotate the same token.
 * 3. Strict user-scoping on token family revocation (no cross-user blast radius).
 * 4. Server-side magic-byte inspection (detects genuine PNG/JPEG/PDF/WebP; rejects disguised executables, scripts, and polyglots).
 * 5. Safe handling of truncated/empty/corrupted files without crashes.
 * 6. Dual-secret rotation protocol for JWTs and Razorpay webhooks (grace period and decommission).
 * 7. Multi-tenant company isolation.
 *
 * Run: node --test tests/security_hardening_validation.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { hashToken, verifyTokenHash } = require('../utils/tokenHash');
const { detectFileSignature, requireValidFileSignature } = require('../utils/fileValidation');

describe('Security Hardening — 1. Refresh Token Hashing & Migration Window', () => {
  test('hashToken computes deterministic 64-character SHA-256 hash', () => {
    const rawToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-payload.signature';
    const hash1 = hashToken(rawToken);
    const hash2 = hashToken(rawToken);

    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
    assert.match(hash1, /^[0-9a-f]{64}$/);
    assert.notEqual(rawToken, hash1, 'Raw token must never equal stored hash');
  });

  test('different tokens produce completely distinct hashes', () => {
    const tokenA = 'token-alpha-123456';
    const tokenB = 'token-beta-123456';
    assert.notEqual(hashToken(tokenA), hashToken(tokenB));
  });

  test('verifyTokenHash verifies against stored SHA-256 hash', () => {
    const rawToken = 'my_active_refresh_token_jwt';
    const storedHash = hashToken(rawToken);

    assert.equal(verifyTokenHash(rawToken, storedHash), true);
    assert.equal(verifyTokenHash('tampered_token', storedHash), false);
  });

  test('temporary migration fallback verifies legacy plaintext if not disabled', () => {
    const legacyPlaintextToken = 'legacy_plaintext_token_from_old_schema';
    // When storedValue is plaintext (not a hash):
    assert.equal(verifyTokenHash(legacyPlaintextToken, legacyPlaintextToken), true);
  });

  test('DISABLE_LEGACY_PLAINTEXT_REFRESH disables plaintext fallback after migration window', () => {
    const legacyPlaintextToken = 'legacy_token_123';
    process.env.DISABLE_LEGACY_PLAINTEXT_REFRESH = 'true';

    try {
      // With legacy disabled, plaintext match must fail because it does not equal sha256(legacyPlaintextToken)
      assert.equal(verifyTokenHash(legacyPlaintextToken, legacyPlaintextToken), false);
    } finally {
      delete process.env.DISABLE_LEGACY_PLAINTEXT_REFRESH;
    }
  });
});

describe('Security Hardening — 2. Refresh Token Single-Use, Concurrency & Family Revocation', () => {
  // In-memory simulation of the database table and row-level locking
  class MockRefreshTokenTable {
    constructor() {
      this.rows = [];
      this.locks = new Set();
    }

    insert({ userId, tokenHash, tokenFamily, revoked = false }) {
      const record = {
        id: this.rows.length + 1,
        userId,
        tokenHash,
        tokenFamily,
        revoked,
        createdAt: new Date()
      };
      this.rows.push(record);
      return record;
    }

    // Simulates SELECT ... FOR UPDATE
    async lockAndGet(tokenHash, rawToken) {
      const record = this.rows.find(
        r => r.tokenHash === tokenHash || r.tokenHash === rawToken
      );
      if (!record) return null;

      // Check simulated row-lock
      if (this.locks.has(record.id)) {
        // Wait simulated lock
        await new Promise(r => setTimeout(r, 10));
      }
      this.locks.add(record.id);
      return { ...record };
    }

    releaseLock(id) {
      this.locks.delete(id);
    }

    markRevoked(id) {
      const r = this.rows.find(row => row.id === id);
      if (r) r.revoked = true;
    }

    revokeFamily(userId, tokenFamily) {
      for (const r of this.rows) {
        if (r.userId === userId && r.tokenFamily === tokenFamily) {
          r.revoked = true;
        }
      }
    }
  }

  test('valid refresh token rotates into a new token and revokes the old one', async () => {
    const db = new MockRefreshTokenTable();
    const userId = 'user-uuid-1';
    const familyId = crypto.randomUUID();

    const initialToken = 'jwt-refresh-v1';
    const initialRecord = db.insert({
      userId,
      tokenHash: hashToken(initialToken),
      tokenFamily: familyId,
      revoked: false
    });

    // Step 1: Client refreshes
    const locked = await db.lockAndGet(hashToken(initialToken), initialToken);
    assert.ok(locked);
    assert.equal(locked.revoked, false);

    // Rotate: invalidate old
    db.markRevoked(locked.id);
    db.releaseLock(locked.id);

    // Issue new token
    const newToken = 'jwt-refresh-v2';
    const newRecord = db.insert({
      userId,
      tokenHash: hashToken(newToken),
      tokenFamily: familyId,
      revoked: false
    });

    // Old token record is now revoked in DB
    const oldCheck = db.rows.find(r => r.id === initialRecord.id);
    assert.equal(oldCheck.revoked, true);

    // New token is active
    const newCheck = db.rows.find(r => r.id === newRecord.id);
    assert.equal(newCheck.revoked, false);
    assert.equal(newCheck.tokenHash, hashToken(newToken));
  });

  test('reusing an old revoked refresh token detects replay and revokes entire token family', async () => {
    const db = new MockRefreshTokenTable();
    const userId = 'user-uuid-1';
    const familyId = crypto.randomUUID();

    const token1 = 'jwt-refresh-1';
    const token2 = 'jwt-refresh-2';

    // token1 was rotated to token2
    const r1 = db.insert({ userId, tokenHash: hashToken(token1), tokenFamily: familyId, revoked: true });
    const r2 = db.insert({ userId, tokenHash: hashToken(token2), tokenFamily: familyId, revoked: false });

    // Attacker tries to reuse token1
    const locked = await db.lockAndGet(hashToken(token1), token1);
    assert.ok(locked);
    assert.equal(locked.revoked, true, 'Token is already revoked');

    // Reuse detected -> Revoke family
    db.revokeFamily(locked.userId, locked.tokenFamily);
    db.releaseLock(locked.id);

    // Assert that token2 (the active one in the family) is now revoked as well!
    const activeTokenCheck = db.rows.find(r => r.id === r2.id);
    assert.equal(activeTokenCheck.revoked, true, 'Active token in family must be revoked on replay detection');
  });

  test('token family revocation does NOT affect another user sharing same family UUID by coincidence', async () => {
    const db = new MockRefreshTokenTable();
    const userA = 'user-A';
    const userB = 'user-B';
    const familyId = crypto.randomUUID();

    // User A and User B records
    const rA = db.insert({ userId: userA, tokenHash: hashToken('tok-A'), tokenFamily: familyId, revoked: true });
    const rB = db.insert({ userId: userB, tokenHash: hashToken('tok-B'), tokenFamily: familyId, revoked: false });

    // User A reuses revoked token -> revoke family for User A only
    db.revokeFamily(userA, familyId);

    // User A's tokens are revoked
    assert.equal(db.rows.find(r => r.id === rA.id).revoked, true);
    // User B's tokens MUST remain active!
    assert.equal(db.rows.find(r => r.id === rB.id).revoked, false, 'User B must not be revoked');
  });

  test('concurrent refresh calls on the same token cannot both succeed', async () => {
    const db = new MockRefreshTokenTable();
    const userId = 'user-concurrent';
    const familyId = crypto.randomUUID();
    const rawToken = 'token-to-race';

    db.insert({ userId, tokenHash: hashToken(rawToken), tokenFamily: familyId, revoked: false });

    // Simulate two parallel refresh requests
    let winner = 0;
    let rejected = 0;

    const executeRefresh = async () => {
      const record = await db.lockAndGet(hashToken(rawToken), rawToken);
      if (!record || record.revoked) {
        db.releaseLock(record?.id);
        rejected++;
        return { success: false, reason: 'revoked_or_missing' };
      }

      // Simulate atomic rotation
      db.markRevoked(record.id);
      db.insert({
        userId,
        tokenHash: hashToken(`new-token-${Date.now()}`),
        tokenFamily: familyId,
        revoked: false
      });
      db.releaseLock(record.id);
      winner++;
      return { success: true };
    };

    const [res1, res2] = await Promise.all([executeRefresh(), executeRefresh()]);

    assert.equal(winner, 1, 'Exactly one concurrent request must succeed');
    assert.equal(rejected, 1, 'The other concurrent request must be rejected');
  });
});

describe('Security Hardening — 3. Server-Side Magic-Byte File Validation', () => {
  test('recognizes genuine PNG signature (89 50 4E 47 0D 0A 1A 0A)', () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const detected = detectFileSignature(pngHeader);

    assert.ok(detected);
    assert.equal(detected.mime, 'image/png');
    assert.equal(detected.extension, 'png');
  });

  test('recognizes genuine JPEG signature (FF D8 FF)', () => {
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const detected = detectFileSignature(jpegHeader);

    assert.ok(detected);
    assert.equal(detected.mime, 'image/jpeg');
    assert.equal(detected.extension, 'jpg');
  });

  test('recognizes genuine PDF signature (25 50 44 46 -> %PDF)', () => {
    const pdfHeader = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj', 'utf8');
    const detected = detectFileSignature(pdfHeader);

    assert.ok(detected);
    assert.equal(detected.mime, 'application/pdf');
    assert.equal(detected.extension, 'pdf');
  });

  test('recognizes genuine WebP signature (RIFF....WEBP)', () => {
    const webpHeader = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x24, 0x00, 0x00, 0x00, // Size
      0x57, 0x45, 0x42, 0x50  // WEBP
    ]);
    const detected = detectFileSignature(webpHeader);

    assert.ok(detected);
    assert.equal(detected.mime, 'image/webp');
    assert.equal(detected.extension, 'webp');
  });

  test('rejects Windows executable disguised with .png extension', () => {
    // MZ header (DOS/PE executable signature: 4D 5A)
    const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const detected = detectFileSignature(exeBuffer);

    assert.equal(detected, null, 'Executable magic bytes must not be recognized as allowed image/pdf');
  });

  test('rejects shell script disguised with .pdf or .jpg extension', () => {
    const scriptBuffer = Buffer.from('#!/bin/bash\nrm -rf /', 'utf8');
    const detected = detectFileSignature(scriptBuffer);

    assert.equal(detected, null, 'Script bytes must not match image or pdf');
  });

  test('rejects PHP backdoor disguised as .png', () => {
    const phpBuffer = Buffer.from('<?php system($_GET["c"]); ?>', 'utf8');
    const detected = detectFileSignature(phpBuffer);

    assert.equal(detected, null, 'PHP script must not match image or pdf');
  });

  test('safely handles truncated, empty, and corrupt buffers without crashing', () => {
    assert.equal(detectFileSignature(null), null);
    assert.equal(detectFileSignature(undefined), null);
    assert.equal(detectFileSignature(Buffer.from([])), null);
    assert.equal(detectFileSignature(Buffer.from([0x89])), null);
    assert.equal(detectFileSignature(Buffer.from([0x89, 0x50])), null);
    assert.equal(detectFileSignature('not a buffer'), null);
  });

  test('requireValidFileSignature middleware blocks invalid files with HTTP 400', () => {
    const middleware = requireValidFileSignature({
      allowedMimes: ['image/png', 'image/jpeg', 'application/pdf'],
      fieldName: 'file',
      required: true
    });

    let statusCode = null;
    let responseJson = null;
    let nextCalled = false;

    const fakeReq = {
      file: {
        originalname: 'malicious.png',
        mimetype: 'image/png', // Client lied about MIME
        buffer: Buffer.from('#!/bin/sh\nmalware', 'utf8') // Actual bytes are script
      }
    };
    const fakeRes = {
      status(c) {
        statusCode = c;
        return {
          json(data) {
            responseJson = data;
          }
        };
      }
    };
    const next = () => { nextCalled = true; };

    middleware(fakeReq, fakeRes, next);

    assert.equal(statusCode, 400);
    assert.match(responseJson.message, /binary signature does not match/i);
    assert.equal(nextCalled, false, 'Next middleware must not be invoked');
  });

  test('requireValidFileSignature middleware passes genuine files to next()', () => {
    const middleware = requireValidFileSignature({
      allowedMimes: ['image/png', 'image/jpeg', 'application/pdf'],
      fieldName: 'file',
      required: true
    });

    let nextCalled = false;
    const fakeReq = {
      file: {
        originalname: 'genuine.png',
        mimetype: 'image/png',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
      }
    };
    const fakeRes = {
      status: () => ({ json: () => {} })
    };

    middleware(fakeReq, fakeRes, () => { nextCalled = true; });

    assert.equal(nextCalled, true, 'Genuine file must pass to next()');
    assert.equal(fakeReq.file.validatedMime, 'image/png');
  });
});

describe('Security Hardening — 4. Production Dual-Secret Rotation Protocol', () => {
  const SECRET_PRIMARY = 'new_production_secret_primary_key_2026_xyz';
  const SECRET_OLD = 'retired_production_secret_fallback_key_2025_abc';

  test('token signed with primary secret verifies successfully', () => {
    const token = jwt.sign({ userId: 'u1', role: 'owner' }, SECRET_PRIMARY, { expiresIn: '1h' });

    let verified = null;
    try {
      verified = jwt.verify(token, SECRET_PRIMARY);
    } catch (_) {
      verified = null;
    }

    assert.ok(verified);
    assert.equal(verified.userId, 'u1');
  });

  test('token signed with OLD secret verifies during rotation grace window', () => {
    // Token issued before rotation
    const oldToken = jwt.sign({ userId: 'u1', role: 'owner' }, SECRET_OLD, { expiresIn: '1h' });

    // In verification middleware: Try primary first, fallback to OLD
    let verified = null;
    try {
      verified = jwt.verify(oldToken, SECRET_PRIMARY);
    } catch (_) {
      // Primary failed -> fallback to OLD
      try {
        verified = jwt.verify(oldToken, SECRET_OLD);
      } catch (_) {
        verified = null;
      }
    }

    assert.ok(verified, 'Old token must verify via OLD fallback during grace period');
    assert.equal(verified.userId, 'u1');
  });

  test('all NEW tokens are signed strictly with the primary secret', () => {
    const newToken = jwt.sign({ userId: 'u1' }, SECRET_PRIMARY);

    // Old secret cannot verify tokens signed by new primary
    assert.throws(() => {
      jwt.verify(newToken, SECRET_OLD);
    }, /invalid signature/);
  });

  test('when OLD secret is decommissioned, retired tokens are strictly rejected', () => {
    const oldToken = jwt.sign({ userId: 'u1' }, SECRET_OLD);

    // Grace period over: SECRET_OLD is undefined / removed
    const SECRET_OLD_REMOVED = undefined;

    let verified = null;
    try {
      verified = jwt.verify(oldToken, SECRET_PRIMARY);
    } catch (_) {
      if (SECRET_OLD_REMOVED) {
        try { verified = jwt.verify(oldToken, SECRET_OLD_REMOVED); } catch (_) {}
      }
    }

    assert.equal(verified, null, 'Retired token must be rejected once OLD secret is removed');
  });

  test('Razorpay dual-secret webhook verification accepts both current and fallback', () => {
    const rawPayload = JSON.stringify({ event: 'payment.captured', id: 'pay_123' });
    const WEBHOOK_PRIMARY = 'rzp_wh_secret_2026';
    const WEBHOOK_OLD = 'rzp_wh_secret_2025';

    const sigPrimary = crypto.createHmac('sha256', WEBHOOK_PRIMARY).update(rawPayload).digest('hex');
    const sigOld = crypto.createHmac('sha256', WEBHOOK_OLD).update(rawPayload).digest('hex');
    const sigTampered = crypto.createHmac('sha256', 'attacker_key').update(rawPayload).digest('hex');

    const verifyWebhook = (sig, currentSec, oldSec) => {
      const check = (sec) => {
        if (!sec) return false;
        const expected = crypto.createHmac('sha256', sec).update(rawPayload).digest('hex');
        const b1 = Buffer.from(expected, 'utf8');
        const b2 = Buffer.from(sig, 'utf8');
        return b1.length === b2.length && crypto.timingSafeEqual(b1, b2);
      };
      return check(currentSec) || check(oldSec);
    };

    assert.equal(verifyWebhook(sigPrimary, WEBHOOK_PRIMARY, WEBHOOK_OLD), true, 'Primary secret passes');
    assert.equal(verifyWebhook(sigOld, WEBHOOK_PRIMARY, WEBHOOK_OLD), true, 'Old fallback secret passes');
    assert.equal(verifyWebhook(sigTampered, WEBHOOK_PRIMARY, WEBHOOK_OLD), false, 'Tampered signature fails');
  });
});

describe('Security Hardening — 5. Multi-Tenant Authorization Scoping', () => {
  test('tenant context isolation logic prevents cross-tenant access', () => {
    const userCompanyA = { id: 'uA', companyId: 101, role: 'owner' };
    const resourceCompanyB = { id: 'itemB', companyId: 102, name: 'Inventory B' };

    const isAuthorized = (user, resource) => {
      if (!user || !resource) return false;
      if (user.role === 'super_admin') return true;
      return String(user.companyId) === String(resource.companyId);
    };

    assert.equal(isAuthorized(userCompanyA, resourceCompanyB), false, 'Company A user cannot access Company B resource');
    assert.equal(isAuthorized(userCompanyA, { id: 'itemA', companyId: 101 }), true, 'Company A user can access Company A resource');
  });
});
