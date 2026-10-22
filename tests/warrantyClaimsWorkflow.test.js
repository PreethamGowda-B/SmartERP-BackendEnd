'use strict';

process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createWarrantyClaimHandler,
  createWarrantyClaimResolveHandler,
  createWarrantyClaimsReadHandler,
  canTransitionWarrantyClaim,
} = require('../routes/warrantyClaims');

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function mockDatabase({ machine = { id: 'machine-a' }, job = { id: 'job-a' }, claim = null, failTimeline = false } = {}) {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.startsWith('SELECT id FROM customer_machines')) return { rows: machine ? [machine] : [] };
      if (sql.startsWith('SELECT id FROM jobs')) return { rows: job ? [job] : [] };
      if (sql.startsWith('INSERT INTO warranty_claims')) {
        return { rows: [{ id: 'claim-a', company_id: 'company-a', status: 'submitted', claim_number: params[1], machine_id: params[2] }] };
      }
      if (sql.startsWith('SELECT * FROM warranty_claims')) return { rows: claim ? [claim] : [] };
      if (sql.startsWith('UPDATE warranty_claims')) {
        return { rows: [{ ...claim, status: params[0], supplier_credit_amount: params[1] }] };
      }
      if (sql.startsWith('INSERT INTO machine_timeline_events')) {
        if (failTimeline) throw Object.assign(new Error('private SQL detail'), { code: 'XX000' });
        return { rows: [{ id: 'timeline-a' }] };
      }
      throw new Error(`Unexpected SQL in warranty test double: ${sql}`);
    },
    release() { released = true; },
  };
  return { db: { connect: async () => client }, queries, wasReleased: () => released };
}

const internalSubmitter = { id: 'employee-a', role: 'employee', companyId: 'company-a' };

test('warranty claim creation requires an internal role and company-owned machine/job', async () => {
  let connections = 0;
  const db = { connect: async () => { connections += 1; throw new Error('Unexpected connection'); } };
  const handler = createWarrantyClaimHandler(db);
  const denied = response();
  await handler({ user: { id: 'customer-a', role: 'customer', companyId: 'company-a' }, body: {} }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(connections, 0);

  const wrongMachine = mockDatabase({ machine: null });
  const machineResponse = response();
  await createWarrantyClaimHandler(wrongMachine.db)(
    { user: internalSubmitter, body: { machine_id: 'machine-b', job_id: 'job-a', spare_part_name: 'Spindle', supplier_name: 'Supplier A' } },
    machineResponse,
  );
  assert.equal(machineResponse.statusCode, 404);
  assert.equal(wrongMachine.queries.some(({ sql }) => sql.startsWith('INSERT INTO warranty_claims')), false);
  assert.ok(wrongMachine.queries.some(({ sql }) => sql === 'ROLLBACK'));

  const wrongJob = mockDatabase({ job: null });
  const jobResponse = response();
  await createWarrantyClaimHandler(wrongJob.db)(
    { user: internalSubmitter, body: { machine_id: 'machine-a', job_id: 'job-b', spare_part_name: 'Spindle', supplier_name: 'Supplier A' } },
    jobResponse,
  );
  assert.equal(jobResponse.statusCode, 404);
  assert.equal(wrongJob.queries.some(({ sql }) => sql.startsWith('INSERT INTO warranty_claims')), false);
});

test('warranty claim and machine timeline are committed together, and persistence errors are honest', async () => {
  const mock = mockDatabase();
  const created = response();
  await createWarrantyClaimHandler(mock.db)(
    { user: internalSubmitter, body: { machine_id: 'machine-a', job_id: 'job-a', spare_part_name: 'Spindle', supplier_name: 'Supplier A' } },
    created,
  );
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.success, true);
  assert.ok(mock.queries.some(({ sql, params }) => sql.startsWith('SELECT id FROM customer_machines') && params[1] === 'company-a'));
  assert.ok(mock.queries.some(({ sql, params }) => sql.startsWith('SELECT id FROM jobs') && params[1] === 'company-a'));
  assert.ok(mock.queries.some(({ sql }) => sql.startsWith('INSERT INTO machine_timeline_events')));
  assert.ok(mock.queries.some(({ sql }) => sql === 'COMMIT'));
  assert.equal(mock.wasReleased(), true);

  const failing = mockDatabase({ failTimeline: true });
  const failedResponse = response();
  await createWarrantyClaimHandler(failing.db)(
    { user: internalSubmitter, body: { machine_id: 'machine-a', spare_part_name: 'Spindle', supplier_name: 'Supplier A' } },
    failedResponse,
  );
  assert.equal(failedResponse.statusCode, 500);
  assert.equal(failedResponse.body.success, false);
  assert.equal(failing.queries.some(({ sql }) => sql === 'COMMIT'), false);
  assert.ok(failing.queries.some(({ sql }) => sql === 'ROLLBACK'));
});

test('warranty review validates roles, amounts, allowed transitions, and linked tenant before updating', async () => {
  assert.equal(canTransitionWarrantyClaim('submitted', 'approved'), true);
  assert.equal(canTransitionWarrantyClaim('under_review', 'rejected'), true);
  assert.equal(canTransitionWarrantyClaim('approved', 'approved'), false);
  assert.equal(canTransitionWarrantyClaim('rejected', 'approved'), false);

  const invalidAmount = response();
  let connections = 0;
  await createWarrantyClaimResolveHandler({ connect: async () => { connections += 1; } })(
    { user: { role: 'owner', companyId: 'company-a' }, params: { id: 'claim-a' }, body: { status: 'approved', credit_amount: 'Infinity' } },
    invalidAmount,
  );
  assert.equal(invalidAmount.statusCode, 400);
  assert.equal(connections, 0);

  const terminal = mockDatabase({ claim: { id: 'claim-a', company_id: 'company-a', machine_id: 'machine-a', status: 'approved' } });
  const terminalResponse = response();
  await createWarrantyClaimResolveHandler(terminal.db)(
    { user: { role: 'owner', companyId: 'company-a' }, params: { id: 'claim-a' }, body: { status: 'approved' } },
    terminalResponse,
  );
  assert.equal(terminalResponse.statusCode, 409);
  assert.equal(terminal.queries.some(({ sql }) => sql.startsWith('UPDATE warranty_claims')), false);

  const crossCompany = mockDatabase({ claim: null });
  const missingResponse = response();
  await createWarrantyClaimResolveHandler(crossCompany.db)(
    { user: { role: 'owner', companyId: 'company-b' }, params: { id: 'claim-a' }, body: { status: 'approved' } },
    missingResponse,
  );
  assert.equal(missingResponse.statusCode, 404);
  assert.match(crossCompany.queries[1].sql, /company_id::text = \$2::text/);
});

test('approval persists the claim decision and timeline without claiming a finance credit note', async () => {
  const mock = mockDatabase({ claim: { id: 'claim-a', claim_number: 'WC-123456', company_id: 'company-a', machine_id: 'machine-a', status: 'submitted' } });
  const approved = response();
  await createWarrantyClaimResolveHandler(mock.db)(
    { user: { role: 'owner', companyId: 'company-a' }, params: { id: 'claim-a' }, body: { status: 'approved', credit_amount: 1250 } },
    approved,
  );
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.claim.status, 'approved');
  const timeline = mock.queries.find(({ sql }) => sql.startsWith('INSERT INTO machine_timeline_events'));
  assert.match(timeline.params[3], /no finance credit note was issued/i);
  assert.ok(mock.queries.some(({ sql }) => sql === 'COMMIT'));

  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'SmartERP-Frontend', 'app', 'owner', 'cnc', 'warranty', 'page.tsx'), 'utf8');
  assert.match(source, /No finance credit note was issued/i);
});

test('warranty claim read joins machine metadata within the same company and has no fake supplier defaults', async () => {
  let sql = '';
  const res = response();
  await createWarrantyClaimsReadHandler(async (query) => { sql = query; return { rows: [] }; })(
    { user: { role: 'owner', companyId: 'company-a' } },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.match(sql, /w\.company_id::text = m\.company_id::text/);
  assert.doesNotMatch(sql, /Approved Vendor|CNC Spare Part|CNC Machine/);
});
