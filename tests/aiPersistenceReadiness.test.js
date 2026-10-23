'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const USER_ID = '8a691827-c51b-41fa-8c5a-b31df9903827';
const { schemaIsReady } = require('../routes/aiPersistence.routes').aiPersistenceInternals;

const company = "company_id = NULLIF(current_setting('app.current_company_id'::text, true), ''::text)";
const role = "current_setting('app.current_role'::text, true) = ANY (ARRAY['owner'::text, 'admin'::text])";
const user = "owner_user_id = NULLIF(current_setting('app.current_user_id'::text, true), ''::text)::uuid";
const retention = '(retention_until IS NULL OR retention_until > now())';
const docRetention = '(d.retention_until IS NULL OR d.retention_until > now())';

function policy(tableName, policyName, using, withCheck) {
  return { tableName, policyName, permissive: 'PERMISSIVE', roles: ['public'], command: 'ALL', using, withCheck };
}

function validPolicies() {
  return [
    policy('ai_documents', 'ai_documents_owner_scope',
      `${company} AND ${role} AND deleted_at IS NULL AND superseded_by IS NULL AND ${retention}`,
      `${company} AND ${role} AND ${retention}`),
    policy('ai_document_chunks', 'ai_document_chunks_owner_scope',
      `ai_document_chunks.${company} AND ${role} AND EXISTS (SELECT 1 FROM public.ai_documents d WHERE d.id=ai_document_chunks.document_id AND d.company_id=ai_document_chunks.company_id AND d.company_id=NULLIF(current_setting('app.current_company_id'::text, true), ''::text) AND d.deleted_at IS NULL AND d.superseded_by IS NULL AND ${docRetention})`,
      `ai_document_chunks.${company} AND ${role} AND EXISTS (SELECT 1 FROM public.ai_documents d WHERE d.id=ai_document_chunks.document_id AND d.company_id=ai_document_chunks.company_id AND d.deleted_at IS NULL AND ${docRetention})`),
    policy('ai_conversations', 'ai_conversations_owner_scope', `${company} AND ${user}`, `${company} AND ${user}`),
    policy('ai_conversation_messages', 'ai_conversation_messages_owner_scope',
      `ai_conversation_messages.${company} AND ai_conversation_messages.${user} AND EXISTS (SELECT 1 FROM public.ai_conversations c WHERE c.id=ai_conversation_messages.conversation_id AND c.company_id=ai_conversation_messages.company_id AND c.owner_user_id=ai_conversation_messages.owner_user_id AND c.deleted_at IS NULL)`,
      `ai_conversation_messages.${company} AND ai_conversation_messages.${user} AND EXISTS (SELECT 1 FROM public.ai_conversations c WHERE c.id=ai_conversation_messages.conversation_id AND c.company_id=ai_conversation_messages.company_id AND c.owner_user_id=ai_conversation_messages.owner_user_id AND c.deleted_at IS NULL)`),
  ];
}

function mockDb(policies) {
  const flags = [
    'app_role','user_context','company_context','documents','chunks','conversations','messages',
    'documents_rls','chunks_rls','conversations_rls','messages_rls','policies',
    'idempotency_indexes','critical_columns','documents_grants','chunks_grants',
    'conversations_grants','messages_grants','least_privilege',
  ].reduce((result, key) => ({ ...result, [key]: true }), {});
  return { async query() { return { rows: [{ ...flags, ai_policies: policies }] }; } };
}

async function check(policies) {
  return schemaIsReady({ id: USER_ID, companyId: 'company-a' }, mockDb(policies));
}

test('readiness accepts canonical 044/045 retention predicates containing OR', async () => {
  assert.equal(await check(validPolicies()), true);
});

test('readiness rejects a policy missing its company/tenant predicate', async () => {
  const policies = validPolicies();
  policies[0].using = policies[0].using.replace(`${company} AND `, '');
  assert.equal(await check(policies), false);
});

test('readiness rejects additional policies that could broaden access', async () => {
  const policies = validPolicies();
  policies.push({ ...policies[0], policyName: 'unexpected_ai_document_policy' });
  assert.equal(await check(policies), false);
});

test('readiness rejects missing retention write checks', async () => {
  const policies = validPolicies();
  policies[0].withCheck = `${company} AND ${role}`;
  assert.equal(await check(policies), false);
});

test('readiness rejects document policies that expose deleted or superseded rows', async () => {
  const policies = validPolicies();
  policies[0].using = policies[0].using.replace(' AND superseded_by IS NULL', '');
  assert.equal(await check(policies), false);
});

test('readiness rejects broad OR clauses and role predicates outside Owner/Admin', async () => {
  const broad = validPolicies();
  broad[0].using += ' OR true';
  assert.equal(await check(broad), false);

  const wrongRole = validPolicies();
  wrongRole[0].using = wrongRole[0].using.replace(role, "current_setting('app.current_role'::text, true) IS NOT NULL");
  assert.equal(await check(wrongRole), false);
});

test('readiness rejects chunk policies without same-company active parent checks', async () => {
  const policies = validPolicies();
  policies[1].using = policies[1].using.replace(' AND d.superseded_by IS NULL', '');
  assert.equal(await check(policies), false);
});

test('readiness rejects conversation policies missing authenticated user ownership', async () => {
  const policies = validPolicies();
  policies[2].withCheck = `${company}`;
  assert.equal(await check(policies), false);
});

test('readiness rejects lifecycle-incompatible document and chunk write checks', async () => {
  const documentPolicies = validPolicies();
  documentPolicies[0].withCheck += ' AND deleted_at IS NULL';
  assert.equal(await check(documentPolicies), false);

  const chunkPolicies = validPolicies();
  chunkPolicies[1].withCheck += ' AND d.superseded_by IS NULL';
  assert.equal(await check(chunkPolicies), false);
});
