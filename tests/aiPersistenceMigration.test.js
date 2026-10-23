'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  AI_RAG_PERSISTENT_CONVERSATIONS,
  FORWARD_MIGRATIONS,
  STARTUP_MIGRATIONS,
  assertAiRagPersistentConversationsSchema,
} = require('../migrations/forwardMigrationRunner');

const migrationPath = path.join(__dirname, '..', 'migrations', AI_RAG_PERSISTENT_CONVERSATIONS.file);
const sql = fs.readFileSync(migrationPath, 'utf8');

test('AI persistence migration is registered after security baseline and never runs at startup', () => {
  const ids = FORWARD_MIGRATIONS.map(({ id }) => id);
  assert.ok(ids.indexOf('043_security_infrastructure_hardening_and_rls') < ids.indexOf(AI_RAG_PERSISTENT_CONVERSATIONS.id));
  assert.ok(!STARTUP_MIGRATIONS.some(({ id }) => id === AI_RAG_PERSISTENT_CONVERSATIONS.id));
});

test('AI persistence SQL is additive and keeps public roles and truncate access revoked', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.ai_documents/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.ai_conversations/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.ai_documents[\s\S]*FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON public\.ai_documents[\s\S]*FROM smarterp_app/);
  assert.doesNotMatch(sql, /CREATE EXTENSION/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE\s/i);
});

test('post-migration verifier accepts the expected least-privilege schema contract', async () => {
  let queryText = '';
  const client = {
    async query(text) {
      queryText = text;
      return { rows: [{
        table_count: 4,
        forced_rls_count: 4,
        index_count: 10,
        policy_count: 4,
        app_role_safe: true,
        app_grant_count: 4,
        app_unexpected_privilege_count: 0,
        app_truncate_count: 0,
        browser_role_privilege_count: 0,
      }] };
    },
  };
  const result = await assertAiRagPersistentConversationsSchema(client);
  assert.equal(result.forced_rls_count, 4);
  assert.match(queryText, /has_table_privilege/);
});

test('post-migration verifier rejects unsafe role privileges or missing forced RLS', async () => {
  const client = { async query() { return { rows: [{
    table_count: 4,
    forced_rls_count: 3,
    index_count: 10,
    policy_count: 4,
    app_role_safe: false,
    app_grant_count: 4,
    app_unexpected_privilege_count: 0,
    app_truncate_count: 1,
    browser_role_privilege_count: 0,
  }] }; } };
  await assert.rejects(assertAiRagPersistentConversationsSchema(client), /AI RAG\/conversation schema verification failed/);
});
