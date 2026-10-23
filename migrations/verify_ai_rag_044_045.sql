-- Read-only verification queries for manual isolated-database use.
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
  SELECT 'document family version uniqueness is validated',
         EXISTS (SELECT 1 FROM pg_constraint c
          WHERE c.conrelid=to_regclass('public.ai_documents')
            AND c.conname='ai_documents_family_version_key'
            AND c.contype='u' AND c.convalidated
            AND pg_get_constraintdef(c.oid) ILIKE 'UNIQUE (company_id, document_family_id, version)')
  UNION ALL
  SELECT 'ingest request idempotency index is company and uploader scoped',
         EXISTS (SELECT 1 FROM pg_indexes
          WHERE schemaname='public' AND tablename='ai_documents'
            AND indexname='idx_ai_documents_ingest_request'
            AND lower(indexdef) LIKE 'create unique index%'
            AND lower(indexdef) LIKE '%(company_id, uploaded_by, ingest_request_key)%'
            AND lower(indexdef) LIKE '%where (ingest_request_key is not null)%')
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

-- 8) Optional migration 046 maintenance foundation. These checks are expected
-- to be false/not present before 046. After 046, only the executor role should
-- execute the function; no scheduler membership is provisioned by the migration.
SELECT check_name, result
FROM (
  SELECT 'maintenance function exists' AS check_name,
         to_regprocedure('smarterp_ai_maintenance.purge_expired_documents(integer)') IS NOT NULL AS result
  UNION ALL
  SELECT 'maintenance selection indexes present',
         EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
           AND indexname='idx_ai_documents_retention_until'
           AND indexdef ILIKE '%(retention_until, id)%'
           AND indexdef ILIKE '%WHERE (retention_until IS NOT NULL)%')
         AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
           AND indexname='idx_ai_documents_company_superseded_by'
           AND indexdef ILIKE '%(company_id, superseded_by)%'
           AND indexdef ILIKE '%WHERE (superseded_by IS NOT NULL)%')
  UNION ALL
  SELECT 'maintenance owner is non-login, non-superuser BYPASSRLS',
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_ai_retention_owner'
           AND NOT rolcanlogin AND NOT rolsuper AND rolbypassrls)
  UNION ALL
  SELECT 'maintenance executor is non-login and NOBYPASSRLS',
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_ai_retention_executor'
           AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
  UNION ALL
  SELECT 'maintenance function owned by dedicated role and SECURITY DEFINER',
         EXISTS (SELECT 1 FROM pg_proc p
           WHERE p.oid=to_regprocedure('smarterp_ai_maintenance.purge_expired_documents(integer)')
             AND pg_get_userbyid(p.proowner)='smarterp_ai_retention_owner'
             AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog'])
  UNION ALL
  SELECT 'application cannot execute maintenance function',
         CASE WHEN to_regprocedure('smarterp_ai_maintenance.purge_expired_documents(integer)') IS NULL
                    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
              THEN false
              ELSE NOT has_function_privilege('smarterp_app',
                'smarterp_ai_maintenance.purge_expired_documents(integer)','EXECUTE') END
  UNION ALL
  SELECT 'executor can execute maintenance function',
         CASE WHEN to_regprocedure('smarterp_ai_maintenance.purge_expired_documents(integer)') IS NULL
                    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_ai_retention_executor')
              THEN false
              ELSE has_function_privilege('smarterp_ai_retention_executor',
                'smarterp_ai_maintenance.purge_expired_documents(integer)','EXECUTE') END
  UNION ALL
  SELECT 'application cannot assume maintenance roles',
         CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app')
                    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_ai_retention_owner')
                    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_ai_retention_executor')
              THEN false
              ELSE NOT pg_has_role('smarterp_app','smarterp_ai_retention_owner','MEMBER')
                   AND NOT pg_has_role('smarterp_app','smarterp_ai_retention_executor','MEMBER') END
  UNION ALL
  SELECT 'application still has no document DELETE or table TRUNCATE',
         CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app') THEN false
              ELSE NOT has_table_privilege('smarterp_app','public.ai_documents','DELETE')
                   AND NOT has_table_privilege('smarterp_app','public.ai_documents','TRUNCATE')
                   AND NOT has_table_privilege('smarterp_app','public.ai_document_chunks','TRUNCATE') END
  UNION ALL
  SELECT 'function owner has scoped column reads and DELETE only',
         CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_ai_retention_owner') THEN false
              ELSE has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','DELETE')
                   AND has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','DELETE')
                   AND has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','id','SELECT')
                   AND has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','company_id','SELECT')
                   AND has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','retention_until','SELECT')
                   AND has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','superseded_by','SELECT')
                   AND has_column_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','id','SELECT')
                   AND has_column_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','document_id','SELECT')
                   AND has_column_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','company_id','SELECT')
                   AND NOT has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','SELECT')
                   AND NOT has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','SELECT')
                   AND NOT has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','INSERT')
                   AND NOT has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','UPDATE')
                   AND NOT has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','INSERT')
                   AND NOT has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','UPDATE')
                   AND NOT has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','TRUNCATE')
                   AND NOT has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','TRUNCATE')
                   AND NOT has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','extracted_text','SELECT')
                   AND NOT has_column_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','content','SELECT') END
) AS maintenance_checks
ORDER BY check_name;

-- 9) Memberships and security-definer function configuration for review.
SELECT granted.rolname AS granted_role, member.rolname AS member_role,
       m.admin_option
FROM pg_auth_members m
JOIN pg_roles granted ON granted.oid=m.roleid
JOIN pg_roles member ON member.oid=m.member
WHERE granted.rolname IN ('smarterp_ai_retention_owner','smarterp_ai_retention_executor')
ORDER BY granted_role, member_role;

SELECT p.oid::regprocedure AS function_name,
       pg_get_userbyid(p.proowner) AS function_owner,
       p.prosecdef AS security_definer,
       p.proconfig AS function_settings,
       pg_get_functiondef(p.oid) AS function_definition
FROM pg_proc p
WHERE p.oid=to_regprocedure('smarterp_ai_maintenance.purge_expired_documents(integer)');

COMMIT;
