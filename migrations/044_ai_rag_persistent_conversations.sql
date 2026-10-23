-- SmartERP AI Phase 2: company-scoped document chunks and user-owned conversations.
-- Controlled migration: never run at application startup.
--
-- Preconditions before manual execution or controlled-runner use:
--   1. Approve final document ACL and retention/deletion policy before activation.
--   2. Deploy validated app.current_user_id in the DB request context before enabling
--      conversation routes. The current candidate db.js sets it, but this SQL is not
--      registered or executed.
--   3. Confirm the target PostgreSQL schema, users.id UUID type, app role, grants,
--      backup/recovery gate, and migration ordering on an isolated database.
--   4. Select and approve an embedding provider/model and data handling terms before
--      writing embeddings. JSONB storage here does not enable semantic search.
--   5. Select approved PDF/DOCX extraction and document retention behavior.
--
-- No vector extension or automatic startup migration is included. Document
-- policies allow only owner/admin roles in their own company.
-- company_id is TEXT to avoid assuming the mixed
-- integer/UUID company-key types found in existing source/schema snapshots.
-- A pre-existing same-named table/column/index/constraint/policy with an incompatible
-- definition is rejected. This draft never alters or deletes existing business rows.

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('smarterp:forward-migration'),
  hashtext('044_ai_rag_persistent_conversations')
);

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'Migration 044 requires public.users';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'
      AND column_name='id' AND udt_name='uuid' AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'Migration 044 requires public.users.id to be NOT NULL UUID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app') THEN
    RAISE EXCEPTION 'Migration 044 requires the smarterp_app database role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app'
             AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Migration 044 requires smarterp_app without SUPERUSER or BYPASSRLS';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.ai_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  document_family_id UUID NOT NULL DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  media_type VARCHAR(127) NOT NULL,
  source_kind VARCHAR(32) NOT NULL DEFAULT 'upload'
    CHECK (source_kind IN ('upload','manual')),
  source_reference TEXT,
  processing_status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending','processing','ready','failed')),
  content_sha256 CHAR(64),
  ingest_fingerprint CHAR(64),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  ingest_request_key VARCHAR(128),
  processing_attempts INTEGER NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  processing_started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  extracted_text TEXT,
  safe_error_code VARCHAR(64),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  deleted_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ,
  superseded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_documents_id_company_key UNIQUE (id, company_id),
  CONSTRAINT ai_documents_family_version_key UNIQUE (company_id, document_family_id, version),
  CONSTRAINT ai_documents_hash_format CHECK (
    content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ai_documents_ingest_fingerprint_format CHECK (
    ingest_fingerprint IS NULL OR ingest_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ai_documents_superseded_same_company_fk
    FOREIGN KEY (superseded_by, company_id)
    REFERENCES public.ai_documents(id, company_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.ai_document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  document_id UUID NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL CHECK (length(content) > 0),
  search_vector TSVECTOR GENERATED ALWAYS AS
    (to_tsvector('simple'::regconfig, coalesce(content, ''))) STORED,
  embedding JSONB,
  embedding_model VARCHAR(160),
  embedding_dimensions INTEGER,
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_metadata)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_document_chunks_document_order_key
    UNIQUE (company_id, document_id, chunk_index),
  CONSTRAINT ai_document_chunks_document_company_fk
    FOREIGN KEY (document_id, company_id)
    REFERENCES public.ai_documents(id, company_id) ON DELETE CASCADE,
  CONSTRAINT ai_document_chunks_embedding_shape CHECK (
    (embedding IS NULL AND embedding_model IS NULL AND embedding_dimensions IS NULL)
    OR (
      jsonb_typeof(embedding)='array'
      AND embedding_model IS NOT NULL
      AND embedding_dimensions > 0
      AND jsonb_array_length(embedding)=embedding_dimensions
    )
  )
);

CREATE TABLE IF NOT EXISTS public.ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  creation_key VARCHAR(128),
  creation_fingerprint CHAR(64),
  title VARCHAR(255) NOT NULL DEFAULT 'New conversation',
  retention_until TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_conversations_id_company_owner_key UNIQUE (id, company_id, owner_user_id),
  CONSTRAINT ai_conversations_creation_fingerprint_format CHECK (
    creation_fingerprint IS NULL OR creation_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE IF NOT EXISTS public.ai_conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  conversation_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations)='array'),
  response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(response_metadata)='object'),
  request_key VARCHAR(128),
  request_fingerprint CHAR(64),
  request_state VARCHAR(16) NOT NULL DEFAULT 'complete'
    CHECK (request_state IN ('pending','complete','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_conversation_messages_conversation_owner_fk
    FOREIGN KEY (conversation_id, company_id, owner_user_id)
    REFERENCES public.ai_conversations(id, company_id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT ai_conversation_messages_request_fingerprint_format CHECK (
    request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ai_conversation_messages_request_state_role CHECK (
    role='user' OR request_state='complete'
  )
);

-- Validate the minimum column contracts even when CREATE TABLE IF NOT EXISTS skipped
-- an existing object. This makes name collisions fail closed instead of appearing safe.
DO $$
DECLARE
  expected RECORD;
  actual_udt TEXT;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('ai_documents','id','uuid'), ('ai_documents','company_id','text'),
      ('ai_documents','uploaded_by','uuid'), ('ai_documents','processing_status','varchar'),
      ('ai_documents','document_family_id','uuid'), ('ai_documents','ingest_request_key','varchar'),
      ('ai_documents','processing_attempts','int4'), ('ai_documents','retention_until','timestamptz'),
      ('ai_documents','content_sha256','bpchar'), ('ai_documents','extracted_text','text'),
      ('ai_documents','ingest_fingerprint','bpchar'),
      ('ai_document_chunks','document_id','uuid'), ('ai_document_chunks','company_id','text'),
      ('ai_document_chunks','content','text'), ('ai_document_chunks','search_vector','tsvector'),
      ('ai_document_chunks','embedding','jsonb'), ('ai_document_chunks','embedding_model','varchar'),
      ('ai_document_chunks','embedding_dimensions','int4'),
      ('ai_conversations','company_id','text'), ('ai_conversations','owner_user_id','uuid'),
      ('ai_conversations','creation_key','varchar'), ('ai_conversations','creation_fingerprint','bpchar'),
      ('ai_conversation_messages','company_id','text'),
      ('ai_conversation_messages','conversation_id','uuid'),
      ('ai_conversation_messages','owner_user_id','uuid'),
      ('ai_conversation_messages','role','varchar'), ('ai_conversation_messages','citations','jsonb'),
      ('ai_conversation_messages','request_fingerprint','bpchar'),
      ('ai_conversation_messages','request_state','varchar')
    ) AS contract(table_name,column_name,udt_name)
  LOOP
    SELECT c.udt_name INTO actual_udt
    FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name=expected.table_name
      AND c.column_name=expected.column_name;
    IF actual_udt IS DISTINCT FROM expected.udt_name THEN
      RAISE EXCEPTION 'Migration 044 incompatible %.%: expected %, found %',
        expected.table_name, expected.column_name, expected.udt_name, coalesce(actual_udt,'missing');
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('ai_documents','ai_documents_pkey'),
      ('ai_documents','ai_documents_id_company_key'),
      ('ai_documents','ai_documents_family_version_key'),
      ('ai_documents','ai_documents_superseded_same_company_fk'),
      ('ai_documents','ai_documents_hash_format'),
      ('ai_documents','ai_documents_ingest_fingerprint_format'),
      ('ai_document_chunks','ai_document_chunks_pkey'),
      ('ai_document_chunks','ai_document_chunks_document_order_key'),
      ('ai_document_chunks','ai_document_chunks_document_company_fk'),
      ('ai_document_chunks','ai_document_chunks_embedding_shape'),
      ('ai_conversations','ai_conversations_pkey'),
      ('ai_conversations','ai_conversations_id_company_owner_key'),
      ('ai_conversations','ai_conversations_creation_fingerprint_format'),
      ('ai_conversation_messages','ai_conversation_messages_pkey'),
      ('ai_conversation_messages','ai_conversation_messages_conversation_owner_fk'),
      ('ai_conversation_messages','ai_conversation_messages_request_fingerprint_format'),
      ('ai_conversation_messages','ai_conversation_messages_request_state_role')
    ) AS required(table_name,constraint_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname=required.table_name
        AND c.conname=required.constraint_name AND c.convalidated
    )
  ) THEN
    RAISE EXCEPTION 'Migration 044 found a missing or unvalidated required constraint';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_documents_company_uploader_status
  ON public.ai_documents (company_id, uploaded_by, processing_status, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_documents_company_hash
  ON public.ai_documents (company_id, content_sha256)
  WHERE content_sha256 IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_documents_ingest_request
  ON public.ai_documents (company_id, uploaded_by, ingest_request_key)
  WHERE ingest_request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_documents_family_latest
  ON public.ai_documents (company_id, document_family_id, version DESC)
  WHERE deleted_at IS NULL AND superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_document_chunks_search
  ON public.ai_document_chunks USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_ai_document_chunks_company_document
  ON public.ai_document_chunks (company_id, document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_owner_recent
  ON public.ai_conversations (company_id, owner_user_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_conversations_create_request_key
  ON public.ai_conversations (company_id, owner_user_id, creation_key)
  WHERE creation_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_conversation_messages_order
  ON public.ai_conversation_messages (company_id, conversation_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_conversation_messages_user_request_key
  ON public.ai_conversation_messages (company_id, conversation_id, owner_user_id, request_key)
  WHERE role='user' AND request_key IS NOT NULL;

-- CREATE INDEX IF NOT EXISTS alone accepts a conflicting same-name index. Verify
-- table and key expressions after creation or replay.
DO $$
DECLARE
  expected RECORD;
  actual_definition TEXT;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('idx_ai_documents_company_uploader_status','ai_documents','company_id, uploaded_by, processing_status, updated_at desc'),
      ('idx_ai_documents_company_hash','ai_documents','company_id, content_sha256'),
      ('idx_ai_documents_ingest_request','ai_documents','company_id, uploaded_by, ingest_request_key'),
      ('idx_ai_documents_family_latest','ai_documents','company_id, document_family_id, version desc'),
      ('idx_ai_document_chunks_search','ai_document_chunks','using gin (search_vector)'),
      ('idx_ai_document_chunks_company_document','ai_document_chunks','company_id, document_id, chunk_index'),
      ('idx_ai_conversations_owner_recent','ai_conversations','company_id, owner_user_id, updated_at desc'),
      ('idx_ai_conversations_create_request_key','ai_conversations','company_id, owner_user_id, creation_key'),
      ('idx_ai_conversation_messages_order','ai_conversation_messages','company_id, conversation_id, created_at, id'),
      ('idx_ai_conversation_messages_user_request_key','ai_conversation_messages','company_id, conversation_id, owner_user_id, request_key')
    ) AS contract(index_name,table_name,definition_fragment)
  LOOP
    SELECT lower(pg_get_indexdef(c.oid)) INTO actual_definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=expected.index_name AND c.relkind='i';
    IF actual_definition IS NULL
       OR position('on public.' || expected.table_name IN actual_definition)=0
       OR position(lower(expected.definition_fragment) IN actual_definition)=0 THEN
      RAISE EXCEPTION 'Migration 044 found an incompatible or missing index public.%', expected.index_name;
    END IF;
    IF expected.index_name IN ('idx_ai_documents_company_uploader_status','idx_ai_documents_company_hash','idx_ai_documents_ingest_request','idx_ai_documents_family_latest','idx_ai_conversations_owner_recent','idx_ai_conversations_create_request_key')
       AND position('where' IN actual_definition)=0 THEN
      RAISE EXCEPTION 'Migration 044 found a missing partial predicate on public.%', expected.index_name;
    END IF;
    IF expected.index_name='idx_ai_conversation_messages_user_request_key'
       AND (position('create unique index' IN actual_definition)=0 OR position('role' IN actual_definition)=0 OR position('request_key is not null' IN actual_definition)=0) THEN
      RAISE EXCEPTION 'Migration 044 found an incompatible idempotency index';
    END IF;
    IF expected.index_name='idx_ai_conversations_create_request_key'
       AND (position('create unique index' IN actual_definition)=0 OR position('creation_key is not null' IN actual_definition)=0) THEN
      RAISE EXCEPTION 'Migration 044 found an incompatible conversation creation idempotency index';
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.ai_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_document_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversation_messages FORCE ROW LEVEL SECURITY;

-- Initial approved access proposal: Owner/Admin only, scoped to their authenticated
-- company. Employee/customer sharing is excluded until document ACLs are implemented.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ai_documents' AND policyname='ai_documents_owner_scope') THEN
    CREATE POLICY ai_documents_owner_scope ON public.ai_documents FOR ALL
      USING (company_id=NULLIF(current_setting('app.current_company_id',true),'')
        AND current_setting('app.current_role',true) IN ('owner','admin')
        AND (retention_until IS NULL OR retention_until > now()))
      WITH CHECK (company_id=NULLIF(current_setting('app.current_company_id',true),'')
        AND current_setting('app.current_role',true) IN ('owner','admin')
        AND (retention_until IS NULL OR retention_until > now()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ai_document_chunks' AND policyname='ai_document_chunks_owner_scope') THEN
    CREATE POLICY ai_document_chunks_owner_scope ON public.ai_document_chunks FOR ALL
      USING (ai_document_chunks.company_id=NULLIF(current_setting('app.current_company_id',true),'')
        AND current_setting('app.current_role',true) IN ('owner','admin')
        AND EXISTS (SELECT 1 FROM public.ai_documents d WHERE d.id=ai_document_chunks.document_id
          AND d.company_id=ai_document_chunks.company_id
          AND d.deleted_at IS NULL AND (d.retention_until IS NULL OR d.retention_until > now())))
      WITH CHECK (ai_document_chunks.company_id=NULLIF(current_setting('app.current_company_id',true),'')
        AND current_setting('app.current_role',true) IN ('owner','admin')
        AND EXISTS (SELECT 1 FROM public.ai_documents d WHERE d.id=ai_document_chunks.document_id
          AND d.company_id=ai_document_chunks.company_id
          AND d.deleted_at IS NULL AND (d.retention_until IS NULL OR d.retention_until > now())));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ai_conversations' AND policyname='ai_conversations_owner_scope') THEN
    CREATE POLICY ai_conversations_owner_scope ON public.ai_conversations FOR ALL
      USING (company_id=NULLIF(current_setting('app.current_company_id',true),'')
        AND owner_user_id=NULLIF(current_setting('app.current_user_id',true),'')::uuid)
      WITH CHECK (company_id=NULLIF(current_setting('app.current_company_id',true),'')
        AND owner_user_id=NULLIF(current_setting('app.current_user_id',true),'')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ai_conversation_messages' AND policyname='ai_conversation_messages_owner_scope') THEN
    CREATE POLICY ai_conversation_messages_owner_scope ON public.ai_conversation_messages FOR ALL
      USING (ai_conversation_messages.company_id=NULLIF(current_setting('app.current_company_id',true),'')
        AND ai_conversation_messages.owner_user_id=NULLIF(current_setting('app.current_user_id',true),'')::uuid
        AND EXISTS (SELECT 1 FROM public.ai_conversations c WHERE c.id=ai_conversation_messages.conversation_id
          AND c.company_id=ai_conversation_messages.company_id
          AND c.owner_user_id=ai_conversation_messages.owner_user_id AND c.deleted_at IS NULL))
      WITH CHECK (ai_conversation_messages.company_id=NULLIF(current_setting('app.current_company_id',true),'')
        AND ai_conversation_messages.owner_user_id=NULLIF(current_setting('app.current_user_id',true),'')::uuid
        AND EXISTS (SELECT 1 FROM public.ai_conversations c WHERE c.id=ai_conversation_messages.conversation_id
          AND c.company_id=ai_conversation_messages.company_id
          AND c.owner_user_id=ai_conversation_messages.owner_user_id AND c.deleted_at IS NULL));
  END IF;
END $$;

DO $$
DECLARE
  expected RECORD;
  policy_definition TEXT;
  policy_role_ok BOOLEAN;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('ai_documents','ai_documents_owner_scope'),
      ('ai_document_chunks','ai_document_chunks_owner_scope'),
      ('ai_conversations','ai_conversations_owner_scope'),
      ('ai_conversation_messages','ai_conversation_messages_owner_scope')
    ) AS required(table_name,policy_name)
  LOOP
    SELECT lower(coalesce(pg_get_expr(p.polqual,p.polrelid),'') || ' ' ||
                 coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')),
           p.polroles=ARRAY[0::oid]
      INTO policy_definition, policy_role_ok
    FROM pg_policy p JOIN pg_class t ON t.oid=p.polrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=expected.table_name
      AND p.polname=expected.policy_name AND p.polcmd='*';
    IF policy_definition IS NULL OR policy_role_ok IS DISTINCT FROM TRUE
       OR position('app.current_company_id' IN policy_definition)=0
       OR (expected.table_name IN ('ai_conversations','ai_conversation_messages') AND position(' or ' IN policy_definition)>0)
       OR (expected.table_name IN ('ai_documents','ai_document_chunks')
           AND (position('app.current_role' IN policy_definition)=0
             OR position('owner' IN policy_definition)=0 OR position('admin' IN policy_definition)=0))
       OR (expected.table_name IN ('ai_conversations','ai_conversation_messages')
           AND position('app.current_user_id' IN policy_definition)=0) THEN
      RAISE EXCEPTION 'Migration 044 found an incompatible or missing policy public.%', expected.policy_name;
    END IF;
    IF (SELECT count(*) FROM pg_policy p JOIN pg_class t ON t.oid=p.polrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname='public' AND t.relname=expected.table_name) <> 1 THEN
      RAISE EXCEPTION 'Migration 044 found additional policies on public.%; review for access broadening', expected.table_name;
    END IF;
  END LOOP;
END $$;

-- Minimal backend role grants. No browser-facing Supabase role or sequence access.
DO $$
BEGIN
  REVOKE ALL ON public.ai_documents, public.ai_document_chunks,
    public.ai_conversations, public.ai_conversation_messages FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.ai_documents, public.ai_document_chunks,
      public.ai_conversations, public.ai_conversation_messages FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.ai_documents, public.ai_document_chunks,
      public.ai_conversations, public.ai_conversation_messages FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='smarterp_app') THEN
    REVOKE ALL ON public.ai_documents, public.ai_document_chunks,
      public.ai_conversations, public.ai_conversation_messages FROM smarterp_app;
    GRANT SELECT, INSERT, UPDATE ON public.ai_documents TO smarterp_app;
    GRANT SELECT, INSERT, DELETE ON public.ai_document_chunks TO smarterp_app;
    GRANT SELECT, INSERT, UPDATE ON public.ai_conversations TO smarterp_app;
    GRANT SELECT, INSERT, UPDATE ON public.ai_conversation_messages TO smarterp_app;
  END IF;
END $$;

COMMIT;
