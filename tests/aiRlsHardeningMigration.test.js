'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '045_ai_document_active_version_rls.sql'), 'utf8');
const baseMigration = fs.readFileSync(path.join(root, 'migrations', '044_ai_rag_persistent_conversations.sql'), 'utf8');
const verification = fs.readFileSync(path.join(root, 'migrations', 'verify_ai_rag_044_045.sql'), 'utf8');
const readiness = fs.readFileSync(path.join(root, 'routes', 'aiPersistence.routes.js'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'migrations', 'forwardMigrationRunner.js'), 'utf8');

test('045 tightens existing policies in place and preserves the four-policy readiness contract', () => {
  assert.match(migration, /ALTER POLICY ai_documents_owner_scope[\s\S]*?ON public\.ai_documents[\s\S]*?USING/);
  assert.match(migration, /ALTER POLICY ai_document_chunks_owner_scope[\s\S]*?ON public\.ai_document_chunks[\s\S]*?USING/);
  assert.doesNotMatch(migration, /CREATE POLICY|DROP POLICY/i);
  assert.match(migration, /count\(\*\)[\s\S]*<> 4/);
  assert.match(readiness, /count\(\*\)=4/);
  assert.match(runner, /policy_count: 4/);
});

test('045 remains a manual-only follow-up and the verification script is not a numbered migration', () => {
  assert.match(runner, /id: '044_ai_rag_persistent_conversations'/);
  assert.doesNotMatch(runner, /045_ai_document_active_version_rls/);
  assert.equal(path.basename(path.join(root, 'migrations', 'verify_ai_rag_044_045.sql')).startsWith('045_'), false);
});

test('045 requires current company and Owner/Admin plus active, unexpired documents and parents', () => {
  assert.match(migration, /company_id = NULLIF\(current_setting\('app\.current_company_id', true\), ''\)/);
  assert.match(migration, /current_setting\('app\.current_role', true\) IN \('owner','admin'\)/);
  assert.match(migration, /deleted_at IS NULL[\s\S]*superseded_by IS NULL[\s\S]*retention_until IS NULL OR retention_until > now\(\)/);
  assert.match(migration, /d\.id=ai_document_chunks\.document_id[\s\S]*d\.company_id=ai_document_chunks\.company_id[\s\S]*d\.deleted_at IS NULL[\s\S]*d\.superseded_by IS NULL[\s\S]*d\.retention_until IS NULL OR d\.retention_until > now\(\)/);
  assert.match(migration, /d\.company_id=NULLIF\(current_setting\('app\.current_company_id', true\), ''\)/);
});

test('045 leaves lifecycle WITH CHECK expressions untouched and fails closed on mismatches', () => {
  assert.match(migration, /does not change any WITH CHECK expression/i);
  assert.match(migration, /RAISE EXCEPTION 'Migration 045 requires all four migration 044 AI tables'/);
  assert.match(migration, /unexpected or incompatible AI RLS policies/);
  assert.match(migration, /public\.ai_conversations/);
  assert.match(migration, /public\.ai_conversation_messages/);
  assert.doesNotMatch(migration, /ALTER POLICY ai_conversations_owner_scope|ALTER POLICY ai_conversation_messages_owner_scope/);
  assert.match(baseMigration, /retention_until IS NULL OR retention_until > now\(\)/i);
  assert.doesNotMatch(migration, /lower\(coalesce\(qual,[\s\S]*?NOT LIKE '% or %'/i);
  assert.match(migration, /with_check,[\s\S]*?NOT ILIKE '%deleted_at%'[\s\S]*?NOT ILIKE '%superseded_by%'/i);
});

test('verification SQL is read-only and reports pre/post RLS contract details', () => {
  assert.match(verification, /BEGIN READ ONLY/);
  assert.match(verification, /pg_policies/);
  assert.match(verification, /pg_indexes/);
  assert.match(verification, /pg_constraint/);
  assert.match(verification, /has_table_privilege/);
  assert.match(verification, /CASE WHEN EXISTS \(SELECT 1 FROM pg_roles WHERE rolname='smarterp_app'\)/);
  assert.match(verification, /post-045 contract/i);
  assert.doesNotMatch(verification, /^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/im);
});
