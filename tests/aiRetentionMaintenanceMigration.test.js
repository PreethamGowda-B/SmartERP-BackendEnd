'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '046_ai_document_retention_maintenance.sql'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'migrations', 'forwardMigrationRunner.js'), 'utf8');
const verification = fs.readFileSync(path.join(root, 'migrations', 'verify_ai_rag_044_045.sql'), 'utf8');

test('046 is manual-only; 044 stays controlled and 045 stays unregistered', () => {
  assert.match(migration, /requires migrations 044 and 045/i);
  assert.match(migration, /expected four-policy migration 045 state/i);
  assert.doesNotMatch(runner, /046_ai_document_retention_maintenance/);
  assert.doesNotMatch(runner, /045_ai_document_active_version_rls/);
  assert.match(runner, /id: '044_ai_rag_persistent_conversations'/);
  assert.match(runner, /CONTROLLED_MIGRATION_IDS/);
});

test('046 maintenance roles are non-login and web role cannot assume or execute them', () => {
  assert.match(migration, /CREATE ROLE smarterp_ai_retention_owner[\s\S]*NOLOGIN[\s\S]*NOSUPERUSER[\s\S]*BYPASSRLS/);
  assert.match(migration, /CREATE ROLE smarterp_ai_retention_executor[\s\S]*NOLOGIN[\s\S]*NOSUPERUSER[\s\S]*NOBYPASSRLS/);
  assert.match(migration, /WITH RECURSIVE inherited\(roleid\)[\s\S]*smarterp_app[\s\S]*smarterp_ai_retention_owner/);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM smarterp_app/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*TO smarterp_ai_retention_executor/);
  assert.match(migration, /GRANT SELECT \(id, company_id, retention_until, superseded_by\)[\s\S]*ON public\.ai_documents/);
  assert.match(migration, /GRANT SELECT \(id, document_id, company_id\)[\s\S]*ON public\.ai_document_chunks/);
  assert.match(migration, /no login-role memberships before scheduler approval/i);
  assert.match(migration, /has_function_privilege\('smarterp_app'[\s\S]*'EXECUTE'/);
  assert.match(migration, /has_table_privilege\('smarterp_app','public\.ai_documents','DELETE'\)/);
  assert.match(migration, /has_table_privilege\('smarterp_app','public\.ai_document_chunks','TRUNCATE'\)/);
  assert.match(migration, /has_table_privilege\('smarterp_ai_retention_owner','public\.ai_documents','INSERT'\)/);
  assert.match(migration, /has_table_privilege\('smarterp_ai_retention_owner','public\.ai_document_chunks','UPDATE'\)/);
});

test('046 purge is bounded, retention-gated, chain-safe, and concurrency-safe', () => {
  assert.match(migration, /p_batch_size < 1 OR p_batch_size > 500/);
  assert.match(migration, /CREATE INDEX idx_ai_documents_retention_until[\s\S]*retention_until, id/);
  assert.match(migration, /CREATE INDEX idx_ai_documents_company_superseded_by[\s\S]*company_id, superseded_by/);
  assert.match(migration, /d\.retention_until IS NOT NULL[\s\S]*d\.retention_until <= pg_catalog\.clock_timestamp\(\)/);
  assert.match(migration, /predecessor\.superseded_by=d\.id/);
  assert.match(migration, /FOR UPDATE OF d SKIP LOCKED/);
  assert.match(migration, /JOIN unnest\(candidate_ids, candidate_companies\)[\s\S]*selected\.company_id=c\.company_id/);
  assert.match(migration, /LIMIT p_batch_size - chunks_deleted/);
  assert.match(migration, /DELETE FROM public\.ai_document_chunks AS c[\s\S]*DELETE FROM public\.ai_documents AS d/);
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog/);
  assert.doesNotMatch(migration, /DROP POLICY|DISABLE ROW LEVEL SECURITY|GRANT[^;]*TO smarterp_app/i);
  assert.doesNotMatch(migration, /cron\.schedule\s*\(/i);
});

test('046 preflight rejects policy definitions that broaden beyond the canonical active-version contract', () => {
  assert.match(migration, /AND roles=ARRAY\['public'\]::name\[\]/g);
  assert.match(migration, /length\(lower\(coalesce\(qual,''\)\)\)[\s\S]*replace\(lower\(coalesce\(qual,''\)\), ' or ', ''\)\) = 1/);
  assert.match(migration, /length\(lower\(coalesce\(with_check,''\)\)\)[\s\S]*replace\(lower\(coalesce\(with_check,''\)\), ' or ', ''\)\) = 1/);
  assert.match(migration, /position\(' or ' IN lower\(coalesce\(qual,''\)\)\)=0/);
  assert.match(migration, /pg_get_constraintdef\(c\.oid\) NOT ILIKE expected\.definition_pattern/);
  assert.match(migration, /ai_conversation_messages'::regclass\)\s+AND \(NOT relrowsecurity OR NOT relforcerowsecurity\)/);
});

test('read-only verifier includes maintenance postconditions without executing writes', () => {
  assert.match(verification, /smarterp_ai_retention_owner/);
  assert.match(verification, /smarterp_ai_retention_executor/);
  assert.match(verification, /purge_expired_documents/);
  assert.match(verification, /BEGIN READ ONLY/);
  assert.doesNotMatch(verification, /^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE)\b/im);
});
