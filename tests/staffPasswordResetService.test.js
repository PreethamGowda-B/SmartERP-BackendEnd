const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  issueStaffPasswordResetOtp,
  verifyStaffPasswordResetOtp,
  resetStaffPassword,
} = require('../services/staffPasswordResetService');
const { checkPasswordResetRateLimit } = require('../services/passwordResetRateLimiter');

const email = 'google.employee@example.test';
const resetPassword = 'ValidPassword@123';
const computeHmacToken = (value) => crypto.createHmac('sha256', 'unit-test-only').update(String(value)).digest('hex');

function createFakePool({ user = {} } = {}) {
  const state = {
    otpRows: [],
    resetRows: [],
    users: [{ id: 'user-1', email, role: 'employee', is_active: true, password_hash: null, password_set: false, ...user }],
    refreshRows: [{ id: 'refresh-1', user_id: 'user-1' }],
  };

  return {
    state,
    async connect() {
      let snapshot;
      return {
        async query(sql, params = []) {
          const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
          if (normalized === 'begin') {
            snapshot = structuredClone(state);
            return { rows: [] };
          }
          if (normalized === 'commit') { snapshot = null; return { rows: [] }; }
          if (normalized === 'rollback') {
            if (snapshot) {
              state.otpRows = snapshot.otpRows;
              state.resetRows = snapshot.resetRows;
              state.users = snapshot.users;
              state.refreshRows = snapshot.refreshRows;
            }
            snapshot = null;
            return { rows: [] };
          }
          if (normalized.startsWith('select') && normalized.includes('from email_otps')) {
            const row = [...state.otpRows]
              .filter((item) => item.email.toLowerCase() === params[0] && item.account_type === 'staff' && item.purpose === 'password_reset' && !item.used && item.expires_at > Date.now())
              .sort((a, b) => b.created_at - a.created_at)[0];
            return { rows: row ? [{ id: row.id, otp_code: row.otp_code, attempts: row.attempts }] : [] };
          }
          if (normalized.startsWith('update email_otps set attempts')) {
            const row = state.otpRows.find((item) => item.id === params[1]);
            if (row) { row.attempts = params[0]; if (params[0] >= 5) row.used = true; }
            return { rows: [] };
          }
          if (normalized.startsWith('update email_otps set used = true')) {
            const row = state.otpRows.find((item) => item.id === params[0]);
            if (row) row.used = true;
            return { rows: [] };
          }
          if (normalized.includes('from users')) {
            return { rows: state.users.filter((item) => item.email.toLowerCase() === params[0] && item.is_active !== false).map(({ id, email: userEmail }) => ({ id, email: userEmail })) };
          }
          if (normalized.startsWith('delete from email_otps')) {
            state.otpRows = state.otpRows.filter((item) => item.email.toLowerCase() !== params[0] || item.account_type !== 'staff' || item.purpose !== 'password_reset');
            return { rows: [] };
          }
          if (normalized.startsWith('update password_reset_tokens set used = true where lower(email)')) {
            state.resetRows.forEach((item) => { if (item.email.toLowerCase() === params[0] && !item.used) item.used = true; });
            return { rows: [] };
          }
          if (normalized.startsWith('update password_reset_tokens') && normalized.includes('where account_type = \'staff\' and user_id = $1')) {
            state.resetRows.forEach((item) => { if (item.user_id === params[0] && !item.used) item.used = true; });
            return { rows: [] };
          }
          if (normalized.startsWith('insert into email_otps')) {
            state.otpRows.push({ id: `otp-${state.otpRows.length + 1}`, email: params[0], otp_code: params[1], account_type: 'staff', purpose: 'password_reset', expires_at: Date.parse(params[2]), used: false, attempts: 0, created_at: Date.now() });
            return { rows: [] };
          }
          if (normalized.startsWith('insert into password_reset_tokens')) {
            state.resetRows.push({ id: `reset-${state.resetRows.length + 1}`, user_id: params[0], email: params[1], token_hash: params[2], expires_at: params[3], used: false });
            return { rows: [] };
          }
          if (normalized.includes('from password_reset_tokens')) {
            const token = state.resetRows.find((item) => item.token_hash === params[0] && !item.used && new Date(item.expires_at).getTime() > Date.now() && (!params[1] || item.email.toLowerCase() === params[1]));
            return { rows: token ? [{ id: token.id, user_id: token.user_id, email: token.email }] : [] };
          }
          if (normalized.startsWith('update users')) {
            const row = state.users.find((item) => item.id === params[1] && item.is_active !== false && ['owner', 'employee', 'hr', 'super_admin'].includes(item.role));
            if (row) { row.password_hash = params[0]; row.password_set = true; }
            return { rows: row ? [{ id: row.id }] : [] };
          }
          if (normalized.startsWith('update password_reset_tokens set used = true where id')) {
            const row = state.resetRows.find((item) => item.id === params[0]);
            if (row) row.used = true;
            return { rows: [] };
          }
          if (normalized.startsWith('delete from refresh_tokens')) {
            state.refreshRows = state.refreshRows.filter((row) => row.user_id !== params[0]);
            return { rows: [] };
          }
          throw new Error(`Unexpected test SQL: ${normalized}`);
        },
        release() {},
      };
    },
  };
}

async function issueKnownOtp(pool, otp = '654321') {
  return issueStaffPasswordResetOtp({ pool, email, computeHmacToken, generateOtp: () => otp });
}

test('resend replaces the previous OTP and supersedes earlier reset authorizations', async () => {
  const pool = createFakePool();
  pool.state.otpRows.push({ id: 'old-otp', email, account_type: 'staff', purpose: 'password_reset', otp_code: 'old-hash', used: false, expires_at: Date.now() + 60_000 });
  pool.state.resetRows.push({ id: 'old-reset', email, user_id: 'user-1', used: false });

  const returnedOtp = await issueKnownOtp(pool, '123456');

  assert.equal(returnedOtp, '123456');
  assert.equal(pool.state.otpRows.length, 1);
  assert.equal(pool.state.otpRows[0].purpose, 'password_reset');
  assert.notEqual(pool.state.otpRows[0].otp_code, returnedOtp);
  assert.equal(pool.state.resetRows[0].used, true);
});

test('requesting a password-reset OTP preserves email-verification OTPs for the same address', async () => {
  const pool = createFakePool();
  const { state } = pool;
  state.otpRows.push({
    id: 'signup-otp', email, account_type: 'staff', purpose: 'email_verification',
    otp_code: 'legacy-signup-code', used: false, expires_at: Date.now() + 60_000,
  });
  await issueKnownOtp(pool);
  assert.equal(state.otpRows.some((row) => row.id === 'signup-otp'), true);
  assert.equal(state.otpRows.filter((row) => row.purpose === 'password_reset').length, 1);
});

test('wrong OTP increments attempts and does not create reset authorization or update a password', async () => {
  const pool = createFakePool();
  await issueKnownOtp(pool);
  await assert.rejects(
    verifyStaffPasswordResetOtp({ pool, email, otp: '000000', computeHmacToken }),
    (error) => error.status === 400 && /incorrect or expired/i.test(error.message)
  );
  assert.equal(pool.state.otpRows[0].attempts, 1);
  assert.equal(pool.state.resetRows.length, 0);
  assert.equal(pool.state.users[0].password_hash, null);
});

test('general verification OTP cannot be used as a password-reset OTP', async () => {
  const pool = createFakePool();
  pool.state.otpRows.push({
    id: 'general-otp', email, account_type: 'staff', purpose: 'email_verification',
    otp_code: computeHmacToken(`123456${email}`), used: false,
    expires_at: Date.now() + 60_000, attempts: 0, created_at: Date.now(),
  });
  await assert.rejects(
    verifyStaffPasswordResetOtp({ pool, email, otp: '123456', computeHmacToken }),
    (error) => error.status === 400
  );
  assert.equal(pool.state.resetRows.length, 0);
});

test('expired and already-used OTPs are rejected', async () => {
  const pool = createFakePool();
  await issueKnownOtp(pool);
  pool.state.otpRows[0].expires_at = Date.now() - 1;
  await assert.rejects(verifyStaffPasswordResetOtp({ pool, email, otp: '654321', computeHmacToken }), (error) => error.status === 400);
  pool.state.otpRows[0].expires_at = Date.now() + 60_000;
  pool.state.otpRows[0].used = true;
  await assert.rejects(verifyStaffPasswordResetOtp({ pool, email, otp: '654321', computeHmacToken }), (error) => error.status === 400);
});

test('Google-created staff account can set its first password after OTP verification', async () => {
  const pool = createFakePool({ user: { password_hash: null, password_set: false } });
  await issueKnownOtp(pool);
  const authorization = await verifyStaffPasswordResetOtp({ pool, email, otp: '654321', computeHmacToken });
  const result = await resetStaffPassword({
    pool, email, resetToken: authorization.resetToken, newPassword: resetPassword,
    computeHmacToken, bcryptImpl: { hash: async (password) => `hashed:${password}` },
  });
  assert.equal(result.userId, 'user-1');
  assert.equal(pool.state.users[0].password_hash, `hashed:${resetPassword}`);
  assert.equal(pool.state.users[0].password_set, true);
  assert.equal(pool.state.resetRows[0].used, true);
  assert.equal(pool.state.refreshRows.length, 0);
});

test('a reused OTP and reset token are rejected after one successful use', async () => {
  const pool = createFakePool();
  await issueKnownOtp(pool);
  const authorization = await verifyStaffPasswordResetOtp({ pool, email, otp: '654321', computeHmacToken });
  await assert.rejects(verifyStaffPasswordResetOtp({ pool, email, otp: '654321', computeHmacToken }), (error) => error.status === 400);
  await resetStaffPassword({
    pool, email, resetToken: authorization.resetToken, newPassword: resetPassword,
    computeHmacToken, bcryptImpl: { hash: async () => 'hashed-password' },
  });
  await assert.rejects(resetStaffPassword({
    pool, email, resetToken: authorization.resetToken, newPassword: resetPassword,
    computeHmacToken, bcryptImpl: { hash: async () => 'another-hash' },
  }), (error) => error.status === 400);
  assert.equal(pool.state.resetRows.length, 1);
});

test('a failed password update rolls back token consumption and session revocation', async () => {
  const pool = createFakePool();
  await issueKnownOtp(pool);
  const authorization = await verifyStaffPasswordResetOtp({ pool, email, otp: '654321', computeHmacToken });
  await assert.rejects(resetStaffPassword({
    pool, email, resetToken: authorization.resetToken, newPassword: resetPassword,
    computeHmacToken, bcryptImpl: { hash: async () => { throw new Error('simulated hash failure'); } },
  }), /simulated hash failure/);
  assert.equal(pool.state.resetRows[0].used, false);
  assert.equal(pool.state.users[0].password_hash, null);
  assert.equal(pool.state.refreshRows.length, 1);
});

test('password recovery rejects weak passwords before database writes', async () => {
  const pool = createFakePool();
  await assert.rejects(resetStaffPassword({
    pool, email, resetToken: 'unused-token', newPassword: 'weak', computeHmacToken,
  }), (error) => error.status === 400 && /8 characters/i.test(error.message));
});

test('password reset request limit allows five requests and rejects the sixth', async () => {
  const entries = new Map();
  const redis = {
    status: 'ready',
    async incr(key) { const next = Number(entries.get(key) || 0) + 1; entries.set(key, next); return next; },
    async expire() {},
    async ttl() { return 600; },
  };
  for (let i = 0; i < 5; i++) {
    assert.equal((await checkPasswordResetRateLimit(redis, 'reset-limit')).allowed, true);
  }
  const blocked = await checkPasswordResetRateLimit(redis, 'reset-limit');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 600);
});
