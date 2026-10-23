-- SmartERP AI document retention maintenance.
--
-- Requires migrations 044 and 045 to have been reviewed and applied. This
-- migration creates a non-login BYPASSRLS function-owner role and a separate
-- non-login executor role. No scheduler membership is created here. A trusted
-- maintenance scheduler must be explicitly granted membership in the executor
-- role after operational review. smarterp_app receives no function access.
--
-- Retention rule: rows are eligible only after their existing
-- ai_documents.retention_until timestamp has passed. This migration does not
-- invent an additional grace period. A supersession chain is purged oldest
-- first so the self-referencing ON DELETE RESTRICT constraint is preserved.

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('smarterp:forward-migration'),
  hashtext('046_ai_document_retention_maintenance')
);

DO $preflight$
DECLARE
  app_role oid;
BEGIN
  IF to_regclass('public.ai_documents') IS NULL
     OR to_regclass('public.ai_document_chunks') IS NULL
     OR to_regclass('public.ai_conversations') IS NULL
     OR to_regclass('public.ai_conversation_messages') IS NULL THEN
    RAISE EXCEPTION 'Migration 046 requires all four migration 044 AI tables';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname='smarterp_app' AND NOT rolsuper AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Migration 046 requires smarterp_app without SUPERUSER or BYPASSRLS';
  END IF;

  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname='public'
        AND tablename IN ('ai_documents','ai_document_chunks',
                          'ai_conversations','ai_conversation_messages')) <> 4
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='ai_documents'
         AND policyname='ai_documents_owner_scope'
         AND permissive='PERMISSIVE' AND cmd='ALL'
         AND coalesce(qual,'') ILIKE '%app.current_company_id%'
         AND coalesce(qual,'') ILIKE '%app.current_role%'
         AND coalesce(qual,'') ILIKE '%owner%'
         AND coalesce(qual,'') ILIKE '%admin%'
         AND coalesce(qual,'') ILIKE '%deleted_at%'
         AND coalesce(qual,'') ILIKE '%superseded_by%'
         AND coalesce(qual,'') ILIKE '%retention_until%'
         AND coalesce(qual,'') ILIKE '%(retention_until IS NULL) OR (retention_until > now())%'
         AND coalesce(qual,'') ILIKE '%= ANY (ARRAY[''owner''::text, ''admin''::text])%'
         AND roles=ARRAY['public']::name[]
         AND length(lower(coalesce(qual,''))) - length(replace(lower(coalesce(qual,'')), ' or ', '')) = 1
         AND coalesce(with_check,'') ILIKE '%app.current_company_id%'
         AND coalesce(with_check,'') ILIKE '%app.current_role%'
         AND coalesce(with_check,'') ILIKE '%owner%'
         AND coalesce(with_check,'') ILIKE '%admin%'
         AND coalesce(with_check,'') ILIKE '%retention_until%'
         AND coalesce(with_check,'') ILIKE '%(retention_until IS NULL) OR (retention_until > now())%'
         AND coalesce(with_check,'') ILIKE '%= ANY (ARRAY[''owner''::text, ''admin''::text])%'
         AND roles=ARRAY['public']::name[]
         AND length(lower(coalesce(with_check,''))) - length(replace(lower(coalesce(with_check,'')), ' or ', '')) = 1
         AND coalesce(with_check,'') NOT ILIKE '%deleted_at%'
         AND coalesce(with_check,'') NOT ILIKE '%superseded_by%'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='ai_document_chunks'
         AND policyname='ai_document_chunks_owner_scope'
         AND permissive='PERMISSIVE' AND cmd='ALL'
         AND coalesce(qual,'') ILIKE '%app.current_company_id%'
         AND coalesce(qual,'') ILIKE '%app.current_role%'
         AND coalesce(qual,'') ILIKE '%owner%'
         AND coalesce(qual,'') ILIKE '%admin%'
         AND regexp_replace(coalesce(qual,''), '[[:space:]]+', '', 'g') ILIKE '%d.id=ai_document_chunks.document_id%'
         AND regexp_replace(coalesce(qual,''), '[[:space:]]+', '', 'g') ILIKE '%d.company_id=ai_document_chunks.company_id%'
         AND coalesce(qual,'') ILIKE '%d.company_id%'
         AND coalesce(qual,'') ILIKE '%d.deleted_at%'
         AND coalesce(qual,'') ILIKE '%d.superseded_by%'
         AND coalesce(qual,'') ILIKE '%d.retention_until%'
         AND coalesce(qual,'') ILIKE '%(d.retention_until IS NULL) OR (d.retention_until > now())%'
         AND coalesce(qual,'') ILIKE '%= ANY (ARRAY[''owner''::text, ''admin''::text])%'
         AND roles=ARRAY['public']::name[]
         AND length(lower(coalesce(qual,''))) - length(replace(lower(coalesce(qual,'')), ' or ', '')) = 1
         AND coalesce(with_check,'') ILIKE '%app.current_company_id%'
         AND coalesce(with_check,'') ILIKE '%app.current_role%'
         AND coalesce(with_check,'') ILIKE '%owner%'
         AND coalesce(with_check,'') ILIKE '%admin%'
         AND coalesce(with_check,'') ILIKE '%d.deleted_at%'
         AND coalesce(with_check,'') ILIKE '%(d.retention_until IS NULL) OR (d.retention_until > now())%'
         AND coalesce(with_check,'') ILIKE '%= ANY (ARRAY[''owner''::text, ''admin''::text])%'
         AND roles=ARRAY['public']::name[]
         AND length(lower(coalesce(with_check,''))) - length(replace(lower(coalesce(with_check,'')), ' or ', '')) = 1
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
         AND position(' or ' IN lower(coalesce(qual,'')))=0
         AND position(' or ' IN lower(coalesce(with_check,'')))=0
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
         AND position(' or ' IN lower(coalesce(qual,'')))=0
         AND position(' or ' IN lower(coalesce(with_check,'')))=0
     ) THEN
    RAISE EXCEPTION 'Migration 046 requires the expected four-policy migration 045 state';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('ai_documents','id','uuid'),
      ('ai_documents','company_id','text'),
      ('ai_documents','retention_until','timestamptz'),
      ('ai_documents','superseded_by','uuid'),
      ('ai_document_chunks','document_id','uuid'),
      ('ai_document_chunks','company_id','text')
    ) AS expected(table_name,column_name,udt_name)
    LEFT JOIN information_schema.columns c
      ON c.table_schema='public'
     AND c.table_name=expected.table_name
     AND c.column_name=expected.column_name
    WHERE c.column_name IS NULL OR c.udt_name IS DISTINCT FROM expected.udt_name
  ) THEN
    RAISE EXCEPTION 'Migration 046 found incompatible AI document columns';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('ai_documents','ai_documents_superseded_same_company_fk','RESTRICT',
        '%FOREIGN KEY (superseded_by, company_id) REFERENCES ai_documents(id, company_id) ON DELETE RESTRICT%'),
      ('ai_document_chunks','ai_document_chunks_document_company_fk','CASCADE',
        '%FOREIGN KEY (document_id, company_id) REFERENCES ai_documents(id, company_id) ON DELETE CASCADE%')
    ) AS expected(table_name,constraint_name,delete_action,definition_pattern)
    LEFT JOIN pg_constraint c
      ON c.conrelid=to_regclass(format('public.%I',expected.table_name))
     AND c.conname=expected.constraint_name
    WHERE c.oid IS NULL OR c.confdeltype IS DISTINCT FROM
      CASE expected.delete_action WHEN 'RESTRICT' THEN 'r'::"char" ELSE 'c'::"char" END
      OR pg_get_constraintdef(c.oid) NOT ILIKE expected.definition_pattern
  ) THEN
    RAISE EXCEPTION 'Migration 046 found incompatible AI document foreign keys';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN ('public.ai_documents'::regclass,'public.ai_document_chunks'::regclass,
                  'public.ai_conversations'::regclass,'public.ai_conversation_messages'::regclass)
      AND (NOT relrowsecurity OR NOT relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'Migration 046 requires ENABLE and FORCE ROW LEVEL SECURITY on all four AI tables';
  END IF;

  SELECT oid INTO app_role FROM pg_roles WHERE rolname='smarterp_app';
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN ('public.ai_documents'::regclass,'public.ai_document_chunks'::regclass)
      AND relowner=app_role
  ) THEN
    RAISE EXCEPTION 'Migration 046 requires smarterp_app not to own AI document tables';
  END IF;

  IF EXISTS (
    WITH RECURSIVE inherited(roleid) AS (
      SELECT app_role
      UNION
      SELECT m.roleid FROM pg_auth_members m JOIN inherited i ON m.member=i.roleid
    )
    SELECT 1 FROM inherited i JOIN pg_roles r ON r.oid=i.roleid
    WHERE r.rolname IN ('smarterp_ai_retention_owner','smarterp_ai_retention_executor')
  ) THEN
    RAISE EXCEPTION 'Migration 046 refuses an application role with maintenance-role membership';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN
       ('smarterp_ai_retention_owner','smarterp_ai_retention_executor'))
     OR to_regnamespace('smarterp_ai_maintenance') IS NOT NULL
     OR to_regprocedure('smarterp_ai_maintenance.purge_expired_documents(integer)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
       AND indexname IN ('idx_ai_documents_retention_until','idx_ai_documents_company_superseded_by')) THEN
    RAISE EXCEPTION 'Migration 046 found pre-existing maintenance objects; inspect them before proceeding';
  END IF;
END
$preflight$;

CREATE ROLE smarterp_ai_retention_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
CREATE ROLE smarterp_ai_retention_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE SCHEMA smarterp_ai_maintenance AUTHORIZATION smarterp_ai_retention_owner;
REVOKE ALL ON SCHEMA smarterp_ai_maintenance FROM PUBLIC;
REVOKE ALL ON SCHEMA smarterp_ai_maintenance FROM smarterp_app;
GRANT USAGE ON SCHEMA smarterp_ai_maintenance TO smarterp_ai_retention_executor;
GRANT USAGE ON SCHEMA public TO smarterp_ai_retention_owner;

GRANT DELETE ON public.ai_documents, public.ai_document_chunks
  TO smarterp_ai_retention_owner;
GRANT SELECT (id, company_id, retention_until, superseded_by)
  ON public.ai_documents TO smarterp_ai_retention_owner;
GRANT SELECT (id, document_id, company_id)
  ON public.ai_document_chunks TO smarterp_ai_retention_owner;

CREATE INDEX idx_ai_documents_retention_until
  ON public.ai_documents (retention_until, id)
  WHERE retention_until IS NOT NULL;
CREATE INDEX idx_ai_documents_company_superseded_by
  ON public.ai_documents (company_id, superseded_by)
  WHERE superseded_by IS NOT NULL;

CREATE FUNCTION smarterp_ai_maintenance.purge_expired_documents(p_batch_size integer DEFAULT 100)
RETURNS TABLE (documents_deleted bigint, chunks_deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  candidate_ids uuid[];
  candidate_companies text[];
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 500 THEN
    RAISE EXCEPTION 'p_batch_size must be between 1 and 500'
      USING ERRCODE='22023';
  END IF;

  SELECT coalesce(array_agg(selected.id ORDER BY selected.retention_until, selected.id), ARRAY[]::uuid[]),
         coalesce(array_agg(selected.company_id ORDER BY selected.retention_until, selected.id), ARRAY[]::text[])
    INTO candidate_ids, candidate_companies
  FROM (
    SELECT d.id, d.company_id, d.retention_until
    FROM public.ai_documents AS d
    WHERE d.retention_until IS NOT NULL
      AND d.retention_until <= pg_catalog.clock_timestamp()
      -- The FK is ON DELETE RESTRICT. Remove chain roots first; later calls
      -- can remove the next row only after its predecessor has been purged.
      AND NOT EXISTS (
        SELECT 1 FROM public.ai_documents AS predecessor
        WHERE predecessor.company_id=d.company_id
          AND predecessor.superseded_by=d.id
      )
    ORDER BY d.retention_until, d.id
    LIMIT p_batch_size
    FOR UPDATE OF d SKIP LOCKED
  ) AS selected;

  chunks_deleted := 0;
  documents_deleted := 0;

  IF cardinality(candidate_ids) > 0 THEN
    WITH selected_chunks AS MATERIALIZED (
      SELECT c.id, c.company_id
      FROM public.ai_document_chunks AS c
      JOIN unnest(candidate_ids, candidate_companies) AS selected(document_id, company_id)
        ON selected.document_id=c.document_id
       AND selected.company_id=c.company_id
      ORDER BY c.id
      LIMIT p_batch_size
      FOR UPDATE OF c SKIP LOCKED
    ), removed_chunks AS (
      DELETE FROM public.ai_document_chunks AS c
      USING selected_chunks AS selected
      WHERE c.id=selected.id
        AND c.company_id=selected.company_id
      RETURNING 1
    )
    SELECT count(*) INTO chunks_deleted FROM removed_chunks;

    IF chunks_deleted < p_batch_size THEN
      WITH selected_documents AS MATERIALIZED (
        SELECT d.id, d.company_id
        FROM public.ai_documents AS d
        JOIN unnest(candidate_ids, candidate_companies) AS selected(id, company_id)
          ON selected.id=d.id AND selected.company_id=d.company_id
          AND NOT EXISTS (
            SELECT 1 FROM public.ai_document_chunks AS c
            WHERE c.document_id=d.id AND c.company_id=d.company_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.ai_documents AS predecessor
            WHERE predecessor.company_id=d.company_id
              AND predecessor.superseded_by=d.id
          )
        ORDER BY d.retention_until, d.id
        LIMIT p_batch_size - chunks_deleted
        FOR UPDATE OF d SKIP LOCKED
      ), removed_documents AS (
        DELETE FROM public.ai_documents AS d
        USING selected_documents AS selected
        WHERE d.id=selected.id AND d.company_id=selected.company_id
        RETURNING 1
      )
      SELECT count(*) INTO documents_deleted FROM removed_documents;
    END IF;
  END IF;

  RETURN NEXT;
END
$function$;

ALTER FUNCTION smarterp_ai_maintenance.purge_expired_documents(integer)
  OWNER TO smarterp_ai_retention_owner;
REVOKE ALL ON FUNCTION smarterp_ai_maintenance.purge_expired_documents(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION smarterp_ai_maintenance.purge_expired_documents(integer) FROM smarterp_app;
GRANT EXECUTE ON FUNCTION smarterp_ai_maintenance.purge_expired_documents(integer)
  TO smarterp_ai_retention_executor;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname='public'
        AND tablename IN ('ai_documents','ai_document_chunks',
                          'ai_conversations','ai_conversation_messages')) <> 4 THEN
    RAISE EXCEPTION 'Migration 046 unexpectedly changed the four-policy contract';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
       AND indexname='idx_ai_documents_retention_until'
       AND indexdef ILIKE '%(retention_until, id)%'
       AND indexdef ILIKE '%WHERE (retention_until IS NOT NULL)%')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
       AND indexname='idx_ai_documents_company_superseded_by'
       AND indexdef ILIKE '%(company_id, superseded_by)%'
       AND indexdef ILIKE '%WHERE (superseded_by IS NOT NULL)%') THEN
    RAISE EXCEPTION 'Migration 046 maintenance indexes are missing or incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname='smarterp_ai_retention_owner'
      AND NOT rolsuper AND NOT rolcanlogin AND rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname='smarterp_ai_retention_executor'
      AND NOT rolsuper AND NOT rolcanlogin AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Migration 046 maintenance roles have unsafe attributes';
  END IF;

  IF has_function_privilege('smarterp_app',
       'smarterp_ai_maintenance.purge_expired_documents(integer)', 'EXECUTE')
     OR NOT has_function_privilege('smarterp_ai_retention_executor',
       'smarterp_ai_maintenance.purge_expired_documents(integer)', 'EXECUTE')
     OR has_table_privilege('smarterp_app','public.ai_documents','DELETE')
     OR has_table_privilege('smarterp_app','public.ai_document_chunks','TRUNCATE')
     OR NOT has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','DELETE')
     OR NOT has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','DELETE')
     OR NOT has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','id','SELECT')
     OR NOT has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','company_id','SELECT')
     OR NOT has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','retention_until','SELECT')
     OR NOT has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','superseded_by','SELECT')
     OR NOT has_column_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','id','SELECT')
     OR NOT has_column_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','document_id','SELECT')
     OR NOT has_column_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','company_id','SELECT')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','SELECT')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','SELECT')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','INSERT')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','UPDATE')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','TRUNCATE')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','REFERENCES')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_documents','TRIGGER')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','INSERT')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','UPDATE')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','TRUNCATE')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','REFERENCES')
     OR has_table_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','TRIGGER')
     OR has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','title','SELECT')
     OR has_column_privilege('smarterp_ai_retention_owner','public.ai_documents','extracted_text','SELECT')
     OR has_column_privilege('smarterp_ai_retention_owner','public.ai_document_chunks','content','SELECT') THEN
    RAISE EXCEPTION 'Migration 046 privilege postcondition failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid='smarterp_ai_retention_owner'::regrole
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid='smarterp_ai_retention_executor'::regrole
  ) THEN
    RAISE EXCEPTION 'Migration 046 maintenance roles must have no login-role memberships before scheduler approval';
  END IF;

  IF has_table_privilege('smarterp_app','public.ai_documents','TRUNCATE')
     OR has_table_privilege('smarterp_app','public.ai_document_chunks','TRUNCATE') THEN
    RAISE EXCEPTION 'Migration 046 detected unexpected application TRUNCATE access';
  END IF;
END
$postflight$;

COMMIT;
