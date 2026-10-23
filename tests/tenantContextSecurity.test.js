'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTenantContext } = require('../middleware/tenantContext');
const { storage } = require('../middleware/als');

function captureContext(req, initialContext = { isWebRequest: true, bypassRls: false }) {
  let captured;
  storage.run(initialContext, () => {
    setTenantContext(req, {}, () => { captured = storage.getStore(); });
  });
  return captured;
}

test('missing company context never implicitly enables RLS bypass', () => {
  const context = captureContext({
    user: { id: 'user-1', role: 'owner' },
    headers: {},
    query: {},
    method: 'GET',
    path: '/api/ai/conversations',
  });

  assert.equal(context.companyId, undefined);
  assert.equal(context.userId, 'user-1');
  assert.equal(context.bypassRls, false);
});

test('client tenant selectors cannot supply missing trusted company context or enable bypass', () => {
  const context = captureContext({
    user: { id: 'user-1', role: 'owner' },
    headers: { 'x-company-id': 'other-company' },
    query: { company_id: 'other-company' },
    method: 'GET',
    path: '/api/ai/documents',
  });

  assert.equal(context.companyId, undefined);
  assert.equal(context.bypassRls, false);
});

test('trusted authenticated company_id alias is preserved without bypass', () => {
  const context = captureContext({
    user: { id: 'user-1', role: 'owner', company_id: '17' },
    headers: {},
    query: {},
    method: 'GET',
    path: '/api/ai/conversations',
  });

  assert.equal(context.companyId, '17');
  assert.equal(context.bypassRls, false);
});

test('an explicitly established trusted server bypass remains scoped and explicit', () => {
  const context = captureContext({
    user: { id: 'user-1', role: 'employee' },
    headers: {},
    query: {},
    method: 'POST',
    path: '/api/auth/onboarding',
  }, { isWebRequest: true, bypassRls: true });

  assert.equal(context.bypassRls, true);
});
