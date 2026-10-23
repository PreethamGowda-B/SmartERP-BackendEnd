-- Read-only verification queries for manual Supabase SQL Editor use.
-- Confirm the project reference in the Supabase Dashboard before running.
-- This file performs SELECTs only; it does not apply migrations or write data.

BEGIN READ ONLY;

-- 1) Connection identity. Supabase SQL Editor may report postgres here; this
-- does not prove that application requests use smarterp_app.
SELECT current_database() AS database_name,
       current_user AS sql_editor_role,
       current_setting('server_version') AS postgres_version,
       current_setting('transaction_read_only') AS read_only_transaction;

-- 2) Migration 044 baseline and required application role.
SELECT check_name, result
FROM (
  SELECT 'public.users exists with UUID id' AS check_name,
         to_regclass('public.users') IS NOT NULL
         AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema='public' AND table_name='users'
                       AND column_name='id' AND udt_name='uuid'
                       AND is_nullable='NO') AS result
  UNION ALL
  SELECT 'smarterp_app exists without SUPERUSER/BYPASSRLS',
         EXISTS (SELECT 1 FROM pg_roles
                 WHERE rolname='smarterp_app'
                   AND NOT rolsuper AND NOT rolbypassrls)
  UNION ALL
  SELECT 'all four AI tables exist',
         (SELECT count(*)=4 FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p')
            AND c.relname IN ('ai_documents','ai_document_chunks',
                              'ai_conversations','ai_conversation_messages'))
  UNION ALL
  SELECT 'all four AI tables have FORCE RLS',
         (SELECT count(*)=4 FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname IN
            ('ai_documents','ai_document_chunks','ai_conversations','ai_conversation_messages')
            AND c.relrowsecurity AND c.relforcerowsecurity)
  UNION ALL
  SELECT 'exactly four AI policies exist',
         (SELECT count(*)=4 FROM pg_policies
          WHERE schemaname='public' AND tablename IN
            ('ai_documents','ai_document_chunks','ai_conversations','ai_conversation_messages'))
  UNION ALL
  SELECT 'public application migration history exists',
         to_regclass('public.app_migration_history') IS NOT NULL
) AS checks
ORDER BY check_name;

-- 3) Actual column types used by migration 044 and 045.
SELECT table_name, ordinal_position, column_name, data_type, udt_name,
       is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('ai_documents','ai_document_chunks',
                     'ai_conversations','ai_conversation_messages')
ORDER BY table_name, ordinal_position;

-- 4) All policy modes and expressions. Before 045, expect four policies;
-- after 045, still expect four, with the two document USING expressions tighter.
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN ('ai_documents','ai_document_chunks',
                    'ai_conversations','ai_conversation_messages')
ORDER BY tablename, policyname;

-- 5) RLS flags, ownership, indexes, and constraints.
SELECT n.nspname AS schema_name, c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS table_owner,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public'
  AND c.relname IN ('ai_documents','ai_document_chunks',
                    'ai_conversations','ai_conversation_messages')
ORDER BY c.relname;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname='public'
  AND tablename IN ('ai_documents','ai_document_chunks',
                    'ai_conversations','ai_conversation_messages')
ORDER BY tablename, indexname;

SELECT n.nspname AS schema_name, t.relname AS table_name, con.conname,
       con.contype AS constraint_type, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class t ON t.oid=con.conrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE n.nspname='public'
  AND t.relname IN ('ai_documents','ai_document_chunks',
                    'ai_conversations','ai_conversation_messages')
ORDER BY t.relname, con.conname;

-- 6) Effective application grants. No row data is read by this query.
SELECT table_name,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
            THEN has_table_privilege('smarterp_app','public.' || quote_ident(table_name),'SELECT')
            ELSE false END AS can_select,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
            THEN has_table_privilege('smarterp_app','public.' || quote_ident(table_name),'INSERT')
            ELSE false END AS can_insert,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
            THEN has_table_privilege('smarterp_app','public.' || quote_ident(table_name),'UPDATE')
            ELSE false END AS can_update,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
            THEN has_table_privilege('smarterp_app','public.' || quote_ident(table_name),'DELETE')
            ELSE false END AS can_delete,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
            THEN has_table_privilege('smarterp_app','public.' || quote_ident(table_name),'TRUNCATE')
            ELSE false END AS can_truncate
FROM unnest(ARRAY['ai_documents','ai_document_chunks',
                  'ai_conversations','ai_conversation_messages']::text[]) AS t(table_name)
ORDER BY table_name;

-- 7) Post-045 contract. Every row should be true after applying 045.
SELECT check_name, result
FROM (
  SELECT 'policy count remains four' AS check_name,
         (SELECT count(*)=4 FROM pg_policies
          WHERE schemaname='public' AND tablename IN
            ('ai_documents','ai_document_chunks','ai_conversations','ai_conversation_messages')) AS result
  UNION ALL
  SELECT 'documents USING excludes deleted, superseded, and expired rows',
         EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
           AND tablename='ai_documents' AND policyname='ai_documents_owner_scope'
           AND permissive='PERMISSIVE' AND cmd='ALL'
           AND qual ILIKE '%deleted_at%' AND qual ILIKE '%superseded_by%'
           AND qual ILIKE '%retention_until%')
  UNION ALL
  SELECT 'chunks USING checks same-company parent deletion, supersession, and retention',
         EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
           AND tablename='ai_document_chunks' AND policyname='ai_document_chunks_owner_scope'
           AND permissive='PERMISSIVE' AND cmd='ALL'
           AND qual ILIKE '%d.company_id%' AND qual ILIKE '%d.deleted_at%'
           AND qual ILIKE '%d.superseded_by%' AND qual ILIKE '%d.retention_until%')
  UNION ALL
  SELECT 'document write check remains lifecycle-compatible',
         EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
           AND tablename='ai_documents' AND policyname='ai_documents_owner_scope'
           AND with_check ILIKE '%retention_until%'
           AND with_check NOT ILIKE '%deleted_at%'
           AND with_check NOT ILIKE '%superseded_by%')
  UNION ALL
  SELECT 'chunk write check was not tightened with supersession condition',
         EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
           AND tablename='ai_document_chunks' AND policyname='ai_document_chunks_owner_scope'
           AND with_check ILIKE '%d.deleted_at%'
           AND with_check NOT ILIKE '%d.superseded_by%')
) AS checks
ORDER BY check_name;

COMMIT;
