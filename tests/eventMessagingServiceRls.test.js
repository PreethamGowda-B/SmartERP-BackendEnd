'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/smarterp_test';
const EventMessagingService = require('../services/eventMessagingService');
const { storage } = require('../middleware/als');
if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = originalDatabaseUrl;

const companyA = '1';
const companyB = '2';
const ownerId = '00000000-0000-4000-8000-000000000001';
const employeeId = '00000000-0000-4000-8000-000000000002';
const customerId = '00000000-0000-4000-8000-000000000003';

function makeClient({ rejectMessage = false } = {}) {
  const statements = [];
  let released = false;
  const client = {
    statements,
    get released() { return released; },
    async query(sql, params = []) {
      const text = String(sql);
      statements.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('INSERT INTO conversations')) return { rows: [{ id: 'conversation-test-id' }] };
      if (text.includes('SELECT id FROM users')) {
        const members = new Set([ownerId, employeeId, customerId]);
        return { rows: members.has(params[0]) && params[1] === companyA ? [{ id: params[0] }] : [] };
      }
      if (text.includes('INSERT INTO conversation_participants')) return { rows: [] };
      if (text.includes('INSERT INTO messages')) {
        const context = storage.getStore();
        const companyMatch = params[2] != null && String(params[2]) === String(context?.companyId);
        const senderMatch = String(params[1]) === String(context?.userId);
        if (rejectMessage || !companyMatch || !senderMatch) {
          throw Object.assign(new Error('RLS policy rejected message row'), { code: '42501' });
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test double: ${text}`);
    },
    release() { released = true; },
  };
  return client;
}

const input = {
  jobId: 'job-test-id',
  companyId: companyA,
  title: 'Boiler inspection',
  customerId,
  ownerId,
  assignedEmployeeId: employeeId,
};

function runAsCompany(companyId, run, { userId = ownerId, role = 'owner', bypassRls = false } = {}) {
  return storage.run({ companyId, userId, role, bypassRls }, run);
}

test('same-company job message inserts company_id and includes only tenant-authorized participants', async () => {
  const client = makeClient();
  const conversationId = await runAsCompany(companyA, () =>
    EventMessagingService.onJobCreated(input, { connect: async () => client })
  );

  assert.equal(conversationId, 'conversation-test-id');
  const message = client.statements.find(({ text }) => text.includes('INSERT INTO messages'));
  assert.ok(message);
  assert.match(message.text, /conversation_id, sender_id, company_id, message, content/);
  assert.equal(message.params[1], ownerId);
  assert.equal(message.params[2], companyA);
  assert.equal(client.statements.at(-1).text, 'COMMIT');
  assert.equal(client.released, true);
  assert.equal(client.statements.filter(({ text }) => text.includes('INSERT INTO conversation_participants')).length, 3);
});

test('cross-company and missing-tenant contexts fail closed before opening a database client', async () => {
  let connections = 0;
  const connect = async () => { connections += 1; return makeClient(); };

  const crossCompany = await runAsCompany(companyB, () => EventMessagingService.onJobCreated(input, { connect }));
  const missingTenant = await storage.run({ userId: ownerId, role: 'owner', bypassRls: false }, () =>
    EventMessagingService.onJobCreated(input, { connect })
  );
  assert.equal(crossCompany, null);
  assert.equal(missingTenant, null);
  assert.equal(connections, 0);
});

test('a message RLS failure rolls back messaging and is returned as a non-fatal skipped event', async () => {
  const client = makeClient({ rejectMessage: true });
  const result = await runAsCompany(companyA, () =>
    EventMessagingService.onJobCreated(input, { connect: async () => client })
  );
  assert.equal(result, null);
  assert.ok(client.statements.some(({ text }) => text === 'ROLLBACK'));
  assert.equal(client.statements.some(({ text }) => text === 'COMMIT'), false);
  assert.equal(client.released, true);
});

test('messages RLS remains enabled and tenant-scoped', () => {
  const policySql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'rls_policies.sql'), 'utf8');
  const policy = policySql.match(/ALTER TABLE messages ENABLE ROW LEVEL SECURITY;[\s\S]*?CREATE POLICY messages_company_isolation ON messages[\s\S]*?\n  \);/);
  assert.ok(policy);
  assert.match(policy[0], /ALTER TABLE messages FORCE ROW LEVEL SECURITY;/);
  assert.match(policy[0], /messages\.company_id::text = current_setting\('app\.current_company_id', true\)/);
});

test('job creation response remains independent from best-effort messaging failures', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'jobs.js'), 'utf8');
  const eventCall = route.indexOf('EventMessagingService.onJobCreated({');
  const response = route.indexOf('res.json(createdJob);', eventCall);
  assert.ok(eventCall >= 0 && response > eventCall);
  assert.match(route.slice(eventCall, response), /\.catch\(\(\) => \{ \}\)/);
});
