-- SmartERP AI RLS hardening: hide deleted, superseded, or expired documents
-- and their chunks at the database read-policy boundary.
--
-- Run only after 044_ai_rag_persistent_conversations.sql is present in the
-- target database and its preconditions have been independently verified.
-- This migration changes the existing policies in place. It intentionally
-- keeps exactly four AI policies so the current route and migration verifiers
-- continue to accept the schema. It does not change any WITH CHECK expression.

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('smarterp:forward-migration'),
  hashtext('045_ai_document_active_version_rls')
);

DO $$
DECLARE
  docs_forced_rls BOOLEAN;
  chunks_forced_rls BOOLEAN;
BEGIN
  IF to_regclass('public.ai_documents') IS NULL
     OR to_regclass('public.ai_document_chunks') IS NULL
     OR to_regclass('public.ai_conversations') IS NULL
     OR to_regclass('public.ai_conversation_messages') IS NULL THEN
    RAISE EXCEPTION 'Migration 045 requires all four migration 044 AI tables';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname='smarterp_app' AND NOT rolsuper AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Migration 045 requires safe smarterp_app role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('ai_documents','company_id','text'),
      ('ai_documents','deleted_at','timestamptz'),
      ('ai_documents','superseded_by','uuid'),
      ('ai_documents','retention_until','timestamptz'),
      ('ai_document_chunks','company_id','text'),
      ('ai_document_chunks','document_id','uuid')
    ) AS expected(table_name,column_name,udt_name)
    LEFT JOIN information_schema.columns c
      ON c.table_schema='public'
     AND c.table_name=expected.table_name
     AND c.column_name=expected.column_name
    WHERE c.column_name IS NULL OR c.udt_name IS DISTINCT FROM expected.udt_name
  ) THEN
    RAISE EXCEPTION 'Migration 045 found an incompatible AI document column';
  END IF;

  SELECT relrowsecurity AND relforcerowsecurity
    INTO docs_forced_rls
    FROM pg_class WHERE oid='public.ai_documents'::regclass;
  SELECT relrowsecurity AND relforcerowsecurity
    INTO chunks_forced_rls
    FROM pg_class WHERE oid='public.ai_document_chunks'::regclass;
  IF NOT coalesce(docs_forced_rls,false)
     OR NOT coalesce(chunks_forced_rls,false) THEN
    RAISE EXCEPTION 'Migration 045 requires enabled and forced RLS on document tables';
  END IF;

  -- Fail closed if another permissive policy could OR-broaden document access,
  -- or if the baseline policies differ from migration 044.
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname='public'
        AND tablename IN ('ai_documents','ai_document_chunks',
                          'ai_conversations','ai_conversation_messages')) <> 4
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='ai_documents'
         AND policyname='ai_documents_owner_scope'
         AND permissive='PERMISSIVE' AND cmd='ALL'
         AND roles=ARRAY['public']::name[]
         AND coalesce(qual,'') ILIKE '%app.current_company_id%'
         AND coalesce(qual,'') ILIKE '%app.current_role%'
         AND coalesce(qual,'') ILIKE '%owner%'
         AND coalesce(qual,'') ILIKE '%admin%'
         AND coalesce(with_check,'') ILIKE '%app.current_company_id%'
         AND coalesce(with_check,'') ILIKE '%app.current_role%'
         AND coalesce(with_check,'') ILIKE '%retention_until%'
         -- The existing retention predicate intentionally contains OR. The
         -- write check must otherwise remain permissive enough for lifecycle
         -- updates that set deleted_at or superseded_by.
         AND coalesce(with_check,'') NOT ILIKE '%deleted_at%'
         AND coalesce(with_check,'') NOT ILIKE '%superseded_by%'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='ai_document_chunks'
         AND policyname='ai_document_chunks_owner_scope'
         AND permissive='PERMISSIVE' AND cmd='ALL'
         AND roles=ARRAY['public']::name[]
         AND coalesce(qual,'') ILIKE '%app.current_company_id%'
         AND coalesce(qual,'') ILIKE '%app.current_role%'
         AND coalesce(qual,'') ILIKE '%owner%'
         AND coalesce(qual,'') ILIKE '%admin%'
         AND coalesce(qual,'') ILIKE '%d.company_id%'
         AND coalesce(qual,'') ILIKE '%d.deleted_at%'
         AND coalesce(qual,'') ILIKE '%retention_until%'
         AND coalesce(with_check,'') ILIKE '%app.current_company_id%'
         AND coalesce(with_check,'') ILIKE '%app.current_role%'
         AND coalesce(with_check,'') ILIKE '%d.company_id%'
         AND coalesce(with_check,'') ILIKE '%d.deleted_at%'
         AND coalesce(with_check,'') ILIKE '%retention_until%'
         -- Chunk writes remain tied to a live parent, but do not require the
         -- parent to be unsuperseded: re-index/supersession cleanup must work.
         AND coalesce(with_check,'') NOT ILIKE '%d.superseded_by%'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='ai_conversations'
         AND policyname='ai_conversations_owner_scope'
         AND permissive='PERMISSIVE' AND cmd='ALL'
         AND roles=ARRAY['public']::name[]
         AND coalesce(qual,'') ILIKE '%app.current_company_id%'
         AND coalesce(qual,'') ILIKE '%app.current_user_id%'
         AND coalesce(with_check,'') ILIKE '%app.current_company_id%'
         AND coalesce(with_check,'') ILIKE '%app.current_user_id%'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='ai_conversation_messages'
         AND policyname='ai_conversation_messages_owner_scope'
         AND permissive='PERMISSIVE' AND cmd='ALL'
         AND roles=ARRAY['public']::name[]
         AND coalesce(qual,'') ILIKE '%app.current_company_id%'
         AND coalesce(qual,'') ILIKE '%app.current_user_id%'
         AND coalesce(with_check,'') ILIKE '%app.current_company_id%'
         AND coalesce(with_check,'') ILIKE '%app.current_user_id%'
     ) THEN
    RAISE EXCEPTION 'Migration 045 found unexpected or incompatible AI RLS policies';
  END IF;
END $$;

-- USING is narrowed for reads and for the old-row side of UPDATE/DELETE.
-- WITH CHECK is deliberately omitted from ALTER POLICY, so the migration 044
-- write checks remain unchanged: lifecycle updates may set deleted_at or
-- superseded_by after operating on a currently active row.
ALTER POLICY ai_documents_owner_scope
ON public.ai_documents
USING (
  company_id = NULLIF(current_setting('app.current_company_id', true), '')
  AND current_setting('app.current_role', true) IN ('owner','admin')
  AND deleted_at IS NULL
  AND superseded_by IS NULL
  AND (retention_until IS NULL OR retention_until > now())
);

ALTER POLICY ai_document_chunks_owner_scope
ON public.ai_document_chunks
USING (
  company_id = NULLIF(current_setting('app.current_company_id', true), '')
  AND current_setting('app.current_role', true) IN ('owner','admin')
  AND EXISTS (
    SELECT 1
    FROM public.ai_documents AS d
    WHERE d.id=ai_document_chunks.document_id
      AND d.company_id=ai_document_chunks.company_id
      AND d.company_id=NULLIF(current_setting('app.current_company_id', true), '')
      AND d.deleted_at IS NULL
      AND d.superseded_by IS NULL
      AND (d.retention_until IS NULL OR d.retention_until > now())
  )
);

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname='public'
        AND tablename IN ('ai_documents','ai_document_chunks',
                          'ai_conversations','ai_conversation_messages')) <> 4
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='ai_documents'
         AND policyname='ai_documents_owner_scope'
         AND permissive='PERMISSIVE' AND cmd='ALL'
         AND coalesce(qual,'') ILIKE '%deleted_at%'
         AND coalesce(qual,'') ILIKE '%superseded_by%'
         AND coalesce(qual,'') ILIKE '%retention_until%'
         AND coalesce(with_check,'') ILIKE '%retention_until%'
         AND coalesce(with_check,'') NOT ILIKE '%deleted_at%'
         AND coalesce(with_check,'') NOT ILIKE '%superseded_by%'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='ai_document_chunks'
         AND policyname='ai_document_chunks_owner_scope'
         AND permissive='PERMISSIVE' AND cmd='ALL'
         AND coalesce(qual,'') ILIKE '%d.deleted_at%'
         AND coalesce(qual,'') ILIKE '%d.superseded_by%'
         AND coalesce(qual,'') ILIKE '%d.retention_until%'
         AND coalesce(with_check,'') ILIKE '%d.deleted_at%'
         AND coalesce(with_check,'') NOT ILIKE '%d.superseded_by%'
     ) THEN
    RAISE EXCEPTION 'Migration 045 postcondition verification failed';
  END IF;
END $$;

COMMIT;
