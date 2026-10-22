'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.REDIS_URL = '';
const { storage } = require('../middleware/als');
const { authenticateSuperAdmin } = require('../middleware/adminMiddleware');

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('configured Super Admin email receives Super Admin RLS context without enabling bypass', () => {
  const previous = process.env.SUPER_ADMIN_EMAIL;
  process.env.SUPER_ADMIN_EMAIL = 'platform@example.test';
  try {
    storage.run({ companyId: '00000000-0000-4000-8000-000000000001', role: 'owner', userId: 'user-1', bypassRls: false }, () => {
      const res = response();
      let called = false;
      authenticateSuperAdmin({
        user: { email: 'PLATFORM@example.test', role: 'owner' },
        method: 'GET', path: '/announcements',
      }, res, () => {
        called = true;
        const context = storage.getStore();
        assert.equal(context.role, 'super_admin');
        assert.equal(context.companyId, '00000000-0000-4000-8000-000000000001');
        assert.equal(context.bypassRls, false);
      });
      assert.equal(called, true);
    });
  } finally {
    if (previous === undefined) delete process.env.SUPER_ADMIN_EMAIL;
    else process.env.SUPER_ADMIN_EMAIL = previous;
  }
});
