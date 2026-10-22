'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompanySuspensionChecker } = require('../middleware/companySuspensionState');

test('simultaneous company checks share only the in-flight status query', async () => {
  let queryCount = 0;
  let finishQuery;
  const checkSuspended = createCompanySuspensionChecker(() => {
    queryCount += 1;
    if (queryCount > 1) return Promise.resolve({ rows: [{ status: 'active', is_susp: 'false' }] });
    return new Promise((resolve) => { finishQuery = resolve; });
  });

  const first = checkSuspended('company-1');
  const second = checkSuspended('company-1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queryCount, 1);
  finishQuery({ rows: [{ status: 'active', is_susp: 'false' }] });
  assert.deepEqual(await Promise.all([first, second]), [false, false]);

  assert.equal(await checkSuspended('company-1'), false);
  assert.equal(queryCount, 2, 'a later request rechecks current company status');
});

test('company check recognizes either persisted suspension marker', async () => {
  const suspendedByStatus = createCompanySuspensionChecker(async () => ({
    rows: [{ status: 'suspended', is_susp: 'false' }],
  }));
  const suspendedByFlag = createCompanySuspensionChecker(async () => ({
    rows: [{ status: 'active', is_susp: 'true' }],
  }));
  assert.equal(await suspendedByStatus('company-1'), true);
  assert.equal(await suspendedByFlag('company-2'), true);
});

test('failed company checks clear their in-flight entry for a later retry', async () => {
  let queryCount = 0;
  const checkSuspended = createCompanySuspensionChecker(async () => {
    queryCount += 1;
    if (queryCount === 1) throw new Error('database unavailable');
    return { rows: [{ status: 'active', is_susp: 'false' }] };
  });

  await assert.rejects(checkSuspended('company-1'), /database unavailable/);
  assert.equal(await checkSuspended('company-1'), false);
  assert.equal(queryCount, 2);
});
