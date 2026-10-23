'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRlsConfig, applyRlsToClient } = require('../db');

const userA = '8a691827-c51b-4c7d-b9a0-1234567890ab';
const userB = '95decfae-0a32-4b47-8f19-1234567890ab';

function makeClient({ failOn } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (failOn && failOn(text, values)) throw new Error('mocked role or config failure');
      return { rows: [] };
    },
  };
}

test('RLS config includes validated user, company, role and clears malformed identity', () => {
  assert.deepEqual(buildRlsConfig({ companyId: '17', role: ' owner ', userId: userA }), {
    bypassRls: false, role: 'owner', companyId: '17', userId: userA,
  });
  assert.deepEqual(buildRlsConfig({ companyId: 'company;DROP', role: 'owner', userId: 'user-a' }), {
    bypassRls: false, role: 'owner', companyId: '', userId: '',
  });
  assert.deepEqual(buildRlsConfig(undefined), {
    bypassRls: false, role: '', companyId: '', userId: '',
  });
});

test('each pool checkout overwrites company and user context and assumes the non-superuser app role', async () => {
  const client = makeClient();
  await applyRlsToClient(client, { companyId: '17', role: 'owner', userId: userA });
  await applyRlsToClient(client, { companyId: '28', role: 'admin', userId: userB });

  const configCalls = client.calls.filter((call) => String(call.text).includes('set_config'));
  assert.deepEqual(configCalls.map((call) => call.values), [
    ['off', '17', 'owner', userA],
    ['off', '28', 'admin', userB],
  ]);
  assert.equal(client.calls.filter((call) => call.text === 'RESET ROLE').length, 2);
  assert.equal(client.calls.filter((call) => call.text === 'SET ROLE smarterp_app').length, 2);
});

test('missing identity resets pooled session settings and still uses smarterp_app', async () => {
  const client = makeClient();
  await applyRlsToClient(client, { companyId: '17', role: 'owner', userId: userA });
  await applyRlsToClient(client, undefined);
  const lastConfig = client.calls.filter((call) => String(call.text).includes('set_config')).at(-1);
  assert.deepEqual(lastConfig.values, ['off', '', '', '']);
  assert.equal(client.calls.at(-1).text, 'SET ROLE smarterp_app');
});

test('RLS setup failure aborts checkout rather than falling back to the database owner', async () => {
  const client = makeClient({ failOn: (text) => text === 'SET ROLE smarterp_app' });
  await assert.rejects(applyRlsToClient(client, { companyId: '17', role: 'owner', userId: userA }), /mocked role or config failure/);
  assert.equal(client.calls.some((call) => call.text === 'RESET ROLE'), true);
  assert.equal(client.calls.at(-1).text, 'SET ROLE smarterp_app');
  assert.equal(client.calls.some((call) => call.text.includes('fallback')), false);
});

test('explicit bypass is preserved while user context is still set', async () => {
  const client = makeClient();
  await applyRlsToClient(client, { bypassRls: true, companyId: '17', role: 'system', userId: userA });
  const config = client.calls.find((call) => String(call.text).includes('set_config'));
  assert.deepEqual(config.values, ['on', '17', 'system', userA]);
  assert.equal(client.calls.some((call) => call.text === 'SET ROLE smarterp_app'), false);
});
