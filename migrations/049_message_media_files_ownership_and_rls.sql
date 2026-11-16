-- Migration 049: Message media files ownership backfill, indexes, and Row-Level Security
-- Safe, idempotent, zero-downtime migration.
BEGIN;

-- 1. Add ownership columns if not already present
ALTER TABLE public.message_media_files
  ADD COLUMN IF NOT EXISTS company_id TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_by TEXT;

-- 2. Create indexes for fast lookup and tenant-scoped filtering
CREATE INDEX IF NOT EXISTS idx_message_media_files_company_id 
  ON public.message_media_files(company_id);

CREATE INDEX IF NOT EXISTS idx_message_media_files_uploaded_by 
  ON public.message_media_files(uploaded_by);

-- 3. Controlled data backfill:
-- Extract media UUIDs referenced across employee_documents, messages, and job_messages.
-- Strictly detect conflicting and ambiguous ownership: only backfill media where exactly
-- ONE distinct company_id is associated. Ambiguous or unreferenced files remain NULL
-- and thus fail-closed under RLS.
WITH media_refs AS (
    -- References from employee_documents
    SELECT 
        (regexp_match(file_url, '/api/messages/media/([0-9a-fA-F-]{36})'))[1]::uuid AS media_id,
        company_id::text AS company_id,
        uploaded_by::text AS uploader_id
    FROM public.employee_documents
    WHERE file_url ~ '/api/messages/media/[0-9a-fA-F-]{36}'

    UNION ALL

    -- References from internal staff messages
    SELECT 
        (regexp_match(m.media_url, '/api/messages/media/([0-9a-fA-F-]{36})'))[1]::uuid AS media_id,
        c.company_id::text AS company_id,
        m.sender_id::text AS uploader_id
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.media_url ~ '/api/messages/media/[0-9a-fA-F-]{36}'

    UNION ALL

    -- References from customer job messages
    SELECT 
        (regexp_match(jm.media_url, '/api/messages/media/([0-9a-fA-F-]{36})'))[1]::uuid AS media_id,
        j.company_id::text AS company_id,
        jm.sender_id::text AS uploader_id
    FROM public.job_messages jm
    JOIN public.jobs j ON j.id = jm.job_id
    WHERE jm.media_url ~ '/api/messages/media/[0-9a-fA-F-]{36}'
),
reliable_media AS (
    SELECT 
        media_id,
        MIN(company_id) AS resolved_company_id,
        MIN(uploader_id) AS resolved_uploader_id
    FROM media_refs
    WHERE media_id IS NOT NULL AND company_id IS NOT NULL
    GROUP BY media_id
    HAVING COUNT(DISTINCT company_id) = 1 -- Exclude conflicts / cross-company ambiguity
)
UPDATE public.message_media_files m
SET 
    company_id = r.resolved_company_id,
    uploaded_by = r.resolved_uploader_id
FROM reliable_media r
WHERE m.id = r.media_id
  AND m.company_id IS NULL;

-- 4. Enable Row Level Security (RLS) on message_media_files
ALTER TABLE public.message_media_files ENABLE ROW LEVEL SECURITY;

-- 5. Drop existing policies if any to ensure clean idempotent definition
DROP POLICY IF EXISTS message_media_files_select_policy ON public.message_media_files;
DROP POLICY IF EXISTS message_media_files_insert_policy ON public.message_media_files;
DROP POLICY IF EXISTS message_media_files_update_policy ON public.message_media_files;
DROP POLICY IF EXISTS message_media_files_delete_policy ON public.message_media_files;

-- SELECT Policy: Bypass or matching company_id (NULL company_id is inaccessible to tenants)
CREATE POLICY message_media_files_select_policy ON public.message_media_files
  FOR SELECT
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR (
      company_id IS NOT NULL 
      AND company_id = NULLIF(current_setting('app.current_company_id', true), '')
    )
  );

-- INSERT Policy: Bypass or matching company_id
CREATE POLICY message_media_files_insert_policy ON public.message_media_files
  FOR INSERT
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR (
      company_id IS NOT NULL 
      AND company_id = NULLIF(current_setting('app.current_company_id', true), '')
    )
  );

-- UPDATE Policy: Only within same tenant
CREATE POLICY message_media_files_update_policy ON public.message_media_files
  FOR UPDATE
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR (
      company_id IS NOT NULL 
      AND company_id = NULLIF(current_setting('app.current_company_id', true), '')
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR (
      company_id IS NOT NULL 
      AND company_id = NULLIF(current_setting('app.current_company_id', true), '')
    )
  );

-- DELETE Policy: Only within same tenant or bypass
CREATE POLICY message_media_files_delete_policy ON public.message_media_files
  FOR DELETE
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR (
      company_id IS NOT NULL 
      AND company_id = NULLIF(current_setting('app.current_company_id', true), '')
    )
  );

-- 6. Grant necessary CRUD permissions to smarterp_app role
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smarterp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_media_files TO smarterp_app;
  END IF;
END $$;

COMMIT;
