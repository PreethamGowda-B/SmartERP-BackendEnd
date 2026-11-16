'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeMedia } = require('../services/mediaAuthorization');

function pool(rows, membership = []) { let calls = 0; return { query: async () => ({ rows: calls++ === 0 ? rows : membership }) }; }
const staff = { type: 'staff', userId: 'u1', companyId: 'c1', role: 'employee' };

test('media authorization enforces document, conversation, job, detached, and ambiguous relationships', async () => {
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'employee_document', company_id: 'c1', employee_id: 'u1' }]), principal: staff, mediaId: 'm' })).allowed, true);
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'employee_document', company_id: 'c1', employee_id: 'u2' }]), principal: staff, mediaId: 'm' })).allowed, false);
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'staff_message', company_id: 'c1', conversation_id: 'x' }], [{ ok: 1 }]), principal: staff, mediaId: 'm' })).allowed, true);
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'staff_message', company_id: 'c1', conversation_id: 'x' }]), principal: staff, mediaId: 'm' })).allowed, false);
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'job_message', company_id: 'c1', customer_id: 'cust', technician_id: 'u1' }]), principal: staff, mediaId: 'm' })).allowed, true);
  assert.equal((await authorizeMedia({ pool: pool([]), principal: staff, mediaId: 'm' })).status, 404);
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'job_message', company_id: 'c1' }, { kind: 'job_message', company_id: 'c1' }]), principal: staff, mediaId: 'm' })).status, 404);
});

test('customers are limited to their own job chat and never employee documents or staff conversations', async () => {
  const customer = { type: 'customer', customerId: 'cust', companyId: 'c1', role: 'customer' };
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'job_message', company_id: 'c1', customer_id: 'cust', technician_id: 'u1' }]), principal: customer, mediaId: 'm' })).allowed, true);
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'job_message', company_id: 'c1', customer_id: 'other', technician_id: 'u1' }]), principal: customer, mediaId: 'm' })).allowed, false);
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'employee_document', company_id: 'c1', employee_id: 'u1' }]), principal: customer, mediaId: 'm' })).allowed, false);
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'staff_message', company_id: 'c1', conversation_id: 'x' }]), principal: customer, mediaId: 'm' })).allowed, false);
});

test('super admin possesses verified audit authority on valid platform relationships but cannot access detached media', async () => {
  const superAdmin = { type: 'staff', userId: 'sa1', role: 'super_admin' };
  // Valid platform relationship -> authorized
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'employee_document', company_id: 'c1', employee_id: 'u2' }]), principal: superAdmin, mediaId: 'm' })).allowed, true);
  assert.equal((await authorizeMedia({ pool: pool([{ kind: 'staff_message', company_id: 'c1', conversation_id: 'x' }]), principal: superAdmin, mediaId: 'm' })).allowed, true);
  // Detached media -> blocked (never bypasses relationship checks)
  assert.equal((await authorizeMedia({ pool: pool([]), principal: superAdmin, mediaId: 'm' })).status, 404);
});

test('shared media authorizes legitimate intra-company references but strictly rejects conflicting cross-company references', async () => {
  // Shared within company c1 where staff u1 is the technician on job 1
  const intraCompanyShared = [
    { kind: 'job_message', company_id: 'c1', customer_id: 'custA', technician_id: 'u1' },
    { kind: 'job_message', company_id: 'c1', customer_id: 'custB', technician_id: 'u2' }
  ];
  assert.equal((await authorizeMedia({ pool: pool(intraCompanyShared), principal: staff, mediaId: 'm' })).allowed, true);

  // Conflicting across company c1 and c2 -> denied fail-closed
  const crossCompanyConflict = [
    { kind: 'job_message', company_id: 'c1', customer_id: 'custA', technician_id: 'u1' },
    { kind: 'job_message', company_id: 'c2', customer_id: 'custB', technician_id: 'u1' }
  ];
  assert.equal((await authorizeMedia({ pool: pool(crossCompanyConflict), principal: staff, mediaId: 'm' })).status, 404);
});

test('employee document authorization grants access to owner/admin and document owner, but blocks other employees', async () => {
  const docOwner = { type: 'staff', userId: 'emp1', companyId: 'c1', role: 'employee' };
  const otherEmp = { type: 'staff', userId: 'emp2', companyId: 'c1', role: 'employee' };
  const owner = { type: 'staff', userId: 'own1', companyId: 'c1', role: 'owner' };
  const admin = { type: 'staff', userId: 'adm1', companyId: 'c1', role: 'admin' };
  const foreignOwner = { type: 'staff', userId: 'own2', companyId: 'c2', role: 'owner' };

  const docRelationship = [{ kind: 'employee_document', company_id: 'c1', employee_id: 'emp1' }];

  // Document owner can access their own document
  assert.equal((await authorizeMedia({ pool: pool(docRelationship), principal: docOwner, mediaId: 'm' })).allowed, true);

  // Other employee in same company is blocked
  assert.equal((await authorizeMedia({ pool: pool(docRelationship), principal: otherEmp, mediaId: 'm' })).allowed, false);

  // Owner and Admin in same company can access employee document
  assert.equal((await authorizeMedia({ pool: pool(docRelationship), principal: owner, mediaId: 'm' })).allowed, true);
  assert.equal((await authorizeMedia({ pool: pool(docRelationship), principal: admin, mediaId: 'm' })).allowed, true);

  // Foreign company owner is rejected
  assert.equal((await authorizeMedia({ pool: pool(docRelationship), principal: foreignOwner, mediaId: 'm' })).allowed, false);
});

test('token verification authenticates valid customer tokens and rejects forged or expired tokens', () => {
  const jwt = require('jsonwebtoken');
  const secret = 'test-jwt-secret-for-unit-tests-12345';
  const wrongSecret = 'wrong-secret-that-fails-verification';

  // 1. Valid customer token
  const validToken = jwt.sign(
    { id: 'cust1', role: 'customer', companyId: 'c1', email: 'cust@test.com' },
    secret,
    { expiresIn: '1h' }
  );
  const decoded = jwt.verify(validToken, secret);
  assert.equal(decoded.id, 'cust1');
  assert.equal(decoded.role, 'customer');
  assert.equal(decoded.companyId, 'c1');

  // 2. Forged token with wrong secret fails verification
  assert.throws(() => {
    jwt.verify(validToken, wrongSecret);
  }, /invalid signature/);

  // 3. Expired token fails verification
  const expiredToken = jwt.sign(
    { id: 'cust1', role: 'customer', companyId: 'c1' },
    secret,
    { expiresIn: '-1s' }
  );
  assert.throws(() => {
    jwt.verify(expiredToken, secret);
  }, /jwt expired/);

  // 4. Tampered token fails verification
  const tamperedToken = validToken.slice(0, -5) + 'xxxxx';
  assert.throws(() => {
    jwt.verify(tamperedToken, secret);
  }, /invalid signature/);
});
