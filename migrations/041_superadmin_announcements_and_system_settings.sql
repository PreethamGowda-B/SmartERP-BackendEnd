-- Migration 041: Super Admin announcements and platform maintenance settings.
-- Additive and repeatable. Existing settings/announcements are preserved.
-- Run only after verifying the target schema and backup/recovery point.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('smarterp:forward-migration'), hashtext('041_superadmin_announcements_and_system_settings'));

-- These routes join announcements to users and write idempotent notifications.
-- Fail early on a baseline that cannot support those contracts.
DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'Migration 041 requires public.users; no objects were changed.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
      AND column_name = 'id' AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION 'Migration 041 requires public.users.id UUID; no objects were changed.';
  END IF;
  IF to_regclass('public.notifications') IS NULL THEN
    RAISE EXCEPTION 'Migration 041 requires public.notifications; no objects were changed.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications'
      AND column_name = 'data' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'Migration 041 requires public.notifications.data JSONB; no objects were changed.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'smarterp_app' AND NOT rolsuper AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Migration 041 requires the existing NOBYPASSRLS smarterp_app role; no objects were changed.';
  END IF;
END
$preflight$;

-- Migration 001 already adds this column/index. Ensure compatibility for
-- installations where the legacy migration was only partially applied.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

DO $notification_idempotency$
DECLARE
  column_type TEXT;
  index_definition TEXT;
  normalized_definition TEXT;
  index_is_valid BOOLEAN;
BEGIN
  SELECT data_type INTO column_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'notifications'
    AND column_name = 'idempotency_key';
  IF column_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'Migration 041 found an incompatible notifications.idempotency_key type: %', COALESCE(column_type, 'missing');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_notifications_idempotency'
  ) THEN
    IF EXISTS (
      SELECT idempotency_key FROM public.notifications
      WHERE idempotency_key IS NOT NULL
      GROUP BY idempotency_key HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'Migration 041 cannot create notification idempotency uniqueness: duplicate non-null keys exist; reconcile them before retrying.';
    END IF;
    CREATE UNIQUE INDEX idx_notifications_idempotency
      ON public.notifications (idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  END IF;

  SELECT i.indexdef, pi.indisvalid AND pi.indisready AND pi.indisunique
    INTO index_definition, index_is_valid
  FROM pg_indexes i
  JOIN pg_class index_class ON index_class.relname = i.indexname
  JOIN pg_namespace index_schema ON index_schema.oid = index_class.relnamespace
  JOIN pg_index pi ON pi.indexrelid = index_class.oid
  JOIN pg_class table_class ON table_class.oid = pi.indrelid
  JOIN pg_namespace table_schema ON table_schema.oid = table_class.relnamespace
  WHERE i.schemaname = 'public' AND i.indexname = 'idx_notifications_idempotency'
    AND index_schema.nspname = 'public' AND table_schema.nspname = 'public'
    AND table_class.relname = 'notifications';
  IF index_is_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Migration 041 found an invalid, non-unique, or misattached idx_notifications_idempotency index.';
  END IF;
  normalized_definition := regexp_replace(lower(COALESCE(index_definition, '')), '[[:space:]()]', '', 'g');
  IF normalized_definition IS DISTINCT FROM
     'createuniqueindexidx_notifications_idempotencyonpublic.notificationsusingbtreeidempotency_keywhereidempotency_keyisnotnull' THEN
    RAISE EXCEPTION 'Migration 041 found an incompatible idx_notifications_idempotency definition: %', COALESCE(index_definition, 'missing');
  END IF;
END
$notification_idempotency$;

CREATE TABLE IF NOT EXISTS public.announcements (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  priority VARCHAR(50) DEFAULT 'medium',
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- The same table is also used by the existing company HR announcements API.
-- Match company_id to the installed companies.id type; do not coerce or rewrite
-- existing values. These columns remain nullable for platform-wide records.
DO $hr_announcement_columns$
DECLARE
  company_id_type TEXT;
  announcement_company_id_type TEXT;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO company_id_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'companies'
    AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped;

  IF company_id_type IS NULL THEN
    RAISE EXCEPTION 'Migration 041 requires public.companies.id to match HR announcement tenant scope.';
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO announcement_company_id_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'announcements'
    AND a.attname = 'company_id' AND a.attnum > 0 AND NOT a.attisdropped;

  IF announcement_company_id_type IS NULL THEN
    EXECUTE format('ALTER TABLE public.announcements ADD COLUMN company_id %s', company_id_type);
  ELSIF announcement_company_id_type IS DISTINCT FROM company_id_type THEN
    RAISE EXCEPTION 'Migration 041 found announcements.company_id type %, but companies.id is %; inspect before retrying.', announcement_company_id_type, company_id_type;
  END IF;

  ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS target_role VARCHAR(50);
END
$hr_announcement_columns$;

CREATE TABLE IF NOT EXISTS public.system_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- CREATE TABLE IF NOT EXISTS does not validate a pre-existing table. Reject
-- incompatible or partial definitions rather than treating them as success.
DO $table_contracts$
DECLARE
  definition TEXT;
  serial_sequence TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='announcements'
      AND column_name='id' AND data_type='integer' AND is_nullable='NO'
      AND column_default LIKE 'nextval(%'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='announcements'
      AND column_name='title' AND data_type='character varying'
      AND character_maximum_length=255 AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='announcements'
      AND column_name='content' AND data_type='text' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='announcements'
      AND column_name='priority' AND data_type='character varying'
      AND character_maximum_length IN (20, 50)
      AND regexp_replace(lower(COALESCE(column_default, '')), '[[:space:]]', '', 'g') = '''medium''::charactervarying'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='announcements'
      AND column_name='created_by' AND data_type='uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='announcements'
      AND column_name='created_at' AND data_type IN ('timestamp with time zone', 'timestamp without time zone')
      AND regexp_replace(lower(COALESCE(column_default, '')), '[[:space:]]', '', 'g') = 'now()'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='announcements'
      AND column_name='company_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='announcements'
      AND column_name='target_role' AND data_type='character varying'
  ) THEN
    RAISE EXCEPTION 'Migration 041 found an incompatible public.announcements definition; inspect it before retrying.';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid='public.announcements'::regclass AND contype='p';
  IF regexp_replace(lower(COALESCE(definition, '')), '[[:space:]()]', '', 'g') IS DISTINCT FROM 'primarykeyid' THEN
    RAISE EXCEPTION 'Migration 041 requires announcements primary key (id); found %', COALESCE(definition, 'none');
  END IF;
  serial_sequence := pg_get_serial_sequence('public.announcements', 'id');
  IF serial_sequence IS DISTINCT FROM 'public.announcements_id_seq' THEN
    RAISE EXCEPTION 'Migration 041 requires announcements.id to use public.announcements_id_seq; found %', COALESCE(serial_sequence, 'none');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='system_settings'
      AND column_name='key' AND data_type='character varying'
      AND character_maximum_length=100 AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='system_settings'
      AND column_name='value' AND data_type='jsonb' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='system_settings'
      AND column_name='updated_at' AND data_type IN ('timestamp with time zone', 'timestamp without time zone')
      AND regexp_replace(lower(COALESCE(column_default, '')), '[[:space:]]', '', 'g') = 'now()'
  ) THEN
    RAISE EXCEPTION 'Migration 041 found an incompatible public.system_settings definition; inspect it before retrying.';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid='public.system_settings'::regclass AND contype='p';
  IF regexp_replace(lower(COALESCE(definition, '')), '[[:space:]()]', '', 'g') IS DISTINCT FROM 'primarykeykey' THEN
    RAISE EXCEPTION 'Migration 041 requires system_settings primary key (key); found %', COALESCE(definition, 'none');
  END IF;
END
$table_contracts$;

CREATE INDEX IF NOT EXISTS idx_announcements_created_at
  ON public.announcements (created_at DESC);

DO $announcement_index$
DECLARE
  index_definition TEXT;
  index_is_valid BOOLEAN;
BEGIN
  SELECT i.indexdef, pi.indisvalid AND pi.indisready AND NOT pi.indisunique
    INTO index_definition, index_is_valid
  FROM pg_indexes i
  JOIN pg_class index_class ON index_class.relname = i.indexname
  JOIN pg_namespace index_schema ON index_schema.oid = index_class.relnamespace
  JOIN pg_index pi ON pi.indexrelid = index_class.oid
  JOIN pg_class table_class ON table_class.oid = pi.indrelid
  JOIN pg_namespace table_schema ON table_schema.oid = table_class.relnamespace
  WHERE i.schemaname='public' AND i.indexname='idx_announcements_created_at'
    AND index_schema.nspname='public' AND table_schema.nspname='public'
    AND table_class.relname='announcements';
  IF index_is_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Migration 041 found an invalid, unique, or misattached idx_announcements_created_at index.';
  END IF;
  IF regexp_replace(lower(COALESCE(index_definition, '')), '[[:space:]()]', '', 'g') IS DISTINCT FROM
     'createindexidx_announcements_created_atonpublic.announcementsusingbtreecreated_atdesc' THEN
    RAISE EXCEPTION 'Migration 041 found an incompatible idx_announcements_created_at definition: %', COALESCE(index_definition, 'missing');
  END IF;
END
$announcement_index$;

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings FORCE ROW LEVEL SECURITY;

-- Policy names are migration-owned. On replay, verify existing definitions;
-- do not silently accept a same-named policy with different access semantics.
DO $policies$
DECLARE
  existing_policy RECORD;
  expected_superadmin TEXT := '(current_setting(''app.current_role'',true)=''super_admin'')';
  expected_maintenance_read TEXT := '((current_setting(''app.current_role'',true)=''super_admin'')or(((key)=''maintenance_mode'')and(coalesce(current_setting(''app.current_role'',true),'''')='''')))';
  expected_company_read TEXT := '((company_id)::text=nullif(current_setting(''app.current_company_id''::text,true),''''::text))';
  expected_company_write TEXT := '(((company_id)::text=nullif(current_setting(''app.current_company_id''::text,true),''''::text))and(current_setting(''app.current_role''::text,true)=any(array[''owner''::text,''admin''::text,''hr''::text])))';
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename IN ('announcements','system_settings')
      AND policyname NOT IN (
        'smarterp_041_announcements_superadmin',
        'smarterp_041_announcements_company_read',
        'smarterp_041_announcements_company_insert',
        'smarterp_041_announcements_company_delete',
        'smarterp_041_system_settings_superadmin',
        'smarterp_041_maintenance_status_read'
      )
  ) THEN
    RAISE EXCEPTION 'Migration 041 found unrecognized policies on announcements/system_settings; review their access semantics before retrying.';
  END IF;

  -- HR routes expose announcements only within the authenticated company.
  -- Only owner/admin/hr roles may create or delete; all company staff may read
  -- according to the route's target_role filter.
  SELECT * INTO existing_policy FROM pg_policies
  WHERE schemaname='public' AND tablename='announcements' AND policyname='smarterp_041_announcements_company_read';
  IF FOUND THEN
    IF existing_policy.cmd <> 'SELECT' OR existing_policy.permissive <> 'PERMISSIVE'
       OR existing_policy.roles <> ARRAY['public']::name[]
       OR regexp_replace(regexp_replace(lower(COALESCE(existing_policy.qual,'')), '::text', '', 'g'), '[[:space:]]', '', 'g')
          <> regexp_replace(expected_company_read, '::text', '', 'g')
       OR existing_policy.with_check IS NOT NULL THEN
      RAISE EXCEPTION 'Migration 041 found incompatible policy public.smarterp_041_announcements_company_read.';
    END IF;
  ELSE
    EXECUTE $create_policy$
      CREATE POLICY smarterp_041_announcements_company_read ON public.announcements FOR SELECT
      USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
    $create_policy$;
  END IF;

  SELECT * INTO existing_policy FROM pg_policies
  WHERE schemaname='public' AND tablename='announcements' AND policyname='smarterp_041_announcements_company_insert';
  IF FOUND THEN
    IF existing_policy.cmd <> 'INSERT' OR existing_policy.permissive <> 'PERMISSIVE'
       OR existing_policy.roles <> ARRAY['public']::name[]
       OR existing_policy.qual IS NOT NULL
       OR regexp_replace(regexp_replace(lower(COALESCE(existing_policy.with_check,'')), '::text', '', 'g'), '[[:space:]]', '', 'g')
          <> regexp_replace(expected_company_write, '::text', '', 'g') THEN
      RAISE EXCEPTION 'Migration 041 found incompatible policy public.smarterp_041_announcements_company_insert.';
    END IF;
  ELSE
    EXECUTE $create_policy$
      CREATE POLICY smarterp_041_announcements_company_insert ON public.announcements FOR INSERT
      WITH CHECK (
        company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
        AND current_setting('app.current_role', true) IN ('owner', 'admin', 'hr')
      )
    $create_policy$;
  END IF;

  SELECT * INTO existing_policy FROM pg_policies
  WHERE schemaname='public' AND tablename='announcements' AND policyname='smarterp_041_announcements_company_delete';
  IF FOUND THEN
    IF existing_policy.cmd <> 'DELETE' OR existing_policy.permissive <> 'PERMISSIVE'
       OR existing_policy.roles <> ARRAY['public']::name[]
       OR regexp_replace(regexp_replace(lower(COALESCE(existing_policy.qual,'')), '::text', '', 'g'), '[[:space:]]', '', 'g')
          <> regexp_replace(expected_company_write, '::text', '', 'g')
       OR existing_policy.with_check IS NOT NULL THEN
      RAISE EXCEPTION 'Migration 041 found incompatible policy public.smarterp_041_announcements_company_delete.';
    END IF;
  ELSE
    EXECUTE $create_policy$
      CREATE POLICY smarterp_041_announcements_company_delete ON public.announcements FOR DELETE
      USING (
        company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
        AND current_setting('app.current_role', true) IN ('owner', 'admin', 'hr')
      )
    $create_policy$;
  END IF;

  SELECT * INTO existing_policy FROM pg_policies
  WHERE schemaname='public' AND tablename='announcements' AND policyname='smarterp_041_announcements_superadmin';
  IF FOUND THEN
    IF existing_policy.cmd <> 'ALL' OR existing_policy.permissive <> 'PERMISSIVE'
       OR existing_policy.roles <> ARRAY['public']::name[]
       OR regexp_replace(regexp_replace(lower(COALESCE(existing_policy.qual,'')), '::text', '', 'g'), '[[:space:]]', '', 'g') <> expected_superadmin
       OR regexp_replace(regexp_replace(lower(COALESCE(existing_policy.with_check,'')), '::text', '', 'g'), '[[:space:]]', '', 'g') <> expected_superadmin THEN
      RAISE EXCEPTION 'Migration 041 found incompatible policy public.smarterp_041_announcements_superadmin.';
    END IF;
  ELSE
    EXECUTE $create_policy$
      CREATE POLICY smarterp_041_announcements_superadmin ON public.announcements FOR ALL
      USING (current_setting('app.current_role', true) = 'super_admin')
      WITH CHECK (current_setting('app.current_role', true) = 'super_admin')
    $create_policy$;
  END IF;

  SELECT * INTO existing_policy FROM pg_policies
  WHERE schemaname='public' AND tablename='system_settings' AND policyname='smarterp_041_system_settings_superadmin';
  IF FOUND THEN
    IF existing_policy.cmd <> 'ALL' OR existing_policy.permissive <> 'PERMISSIVE'
       OR existing_policy.roles <> ARRAY['public']::name[]
       OR regexp_replace(regexp_replace(lower(COALESCE(existing_policy.qual,'')), '::text', '', 'g'), '[[:space:]]', '', 'g') <> expected_superadmin
       OR regexp_replace(regexp_replace(lower(COALESCE(existing_policy.with_check,'')), '::text', '', 'g'), '[[:space:]]', '', 'g') <> expected_superadmin THEN
      RAISE EXCEPTION 'Migration 041 found incompatible policy public.smarterp_041_system_settings_superadmin.';
    END IF;
  ELSE
    EXECUTE $create_policy$
      CREATE POLICY smarterp_041_system_settings_superadmin ON public.system_settings FOR ALL
      USING (current_setting('app.current_role', true) = 'super_admin')
      WITH CHECK (current_setting('app.current_role', true) = 'super_admin')
    $create_policy$;
  END IF;

  SELECT * INTO existing_policy FROM pg_policies
  WHERE schemaname='public' AND tablename='system_settings' AND policyname='smarterp_041_maintenance_status_read';
  IF FOUND THEN
    IF existing_policy.cmd <> 'SELECT' OR existing_policy.permissive <> 'PERMISSIVE'
       OR existing_policy.roles <> ARRAY['public']::name[]
       OR regexp_replace(regexp_replace(lower(COALESCE(existing_policy.qual,'')), '::text', '', 'g'), '[[:space:]]', '', 'g') <> expected_maintenance_read
       OR existing_policy.with_check IS NOT NULL THEN
      RAISE EXCEPTION 'Migration 041 found incompatible policy public.smarterp_041_maintenance_status_read.';
    END IF;
  ELSE
    EXECUTE $create_policy$
      CREATE POLICY smarterp_041_maintenance_status_read ON public.system_settings FOR SELECT
      USING (
        current_setting('app.current_role', true) = 'super_admin'
        OR (key = 'maintenance_mode' AND COALESCE(current_setting('app.current_role', true), '') = '')
      )
    $create_policy$;
  END IF;
END
$policies$;

REVOKE ALL PRIVILEGES ON TABLE public.announcements, public.system_settings FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE public.announcements_id_seq FROM PUBLIC;

DO $revoke_api_roles$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.announcements, public.system_settings FROM %I', role_name);
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.announcements_id_seq FROM %I', role_name);
    END IF;
  END LOOP;
END
$revoke_api_roles$;

GRANT SELECT, INSERT, DELETE ON TABLE public.announcements TO smarterp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.system_settings TO smarterp_app;
GRANT USAGE, SELECT ON SEQUENCE public.announcements_id_seq TO smarterp_app;

-- Preserve a configured maintenance state; initialize only a missing key.
INSERT INTO public.system_settings (key, value, updated_at)
VALUES ('maintenance_mode', '{"mode":"disabled","message":"Platform is operating normally."}'::jsonb, NOW())
ON CONFLICT (key) DO NOTHING;

COMMIT;
