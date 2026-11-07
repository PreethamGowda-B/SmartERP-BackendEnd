-- Migration 048: reconcile AI audit telemetry with the active application schema.
-- Forward-only: preserve the original 018 fields and all existing audit rows.
BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id TEXT,
  user_id TEXT NOT NULL,
  user_name TEXT,
  role TEXT,
  prompt TEXT,
  action_name TEXT,
  affected_record_id TEXT,
  status TEXT DEFAULT 'SUCCESS',
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ai_audit_logs
  ADD COLUMN IF NOT EXISTS user_role VARCHAR(50),
  ADD COLUMN IF NOT EXISTS tool_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS action_params JSONB,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS portal VARCHAR(50),
  ADD COLUMN IF NOT EXISTS module VARCHAR(100),
  ADD COLUMN IF NOT EXISTS plan_tier VARCHAR(20),
  ADD COLUMN IF NOT EXISTS model_scope VARCHAR(50),
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS blocked BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS prompt_preview TEXT,
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS model VARCHAR(150);

-- Older releases created this newer layout with runtime DDL but omitted the
-- 018 compatibility columns. Add nullable compatibility fields so readers of
-- either layout continue to work; existing records are left untouched.
ALTER TABLE public.ai_audit_logs
  ADD COLUMN IF NOT EXISTS user_name TEXT,
  ADD COLUMN IF NOT EXISTS role TEXT,
  ADD COLUMN IF NOT EXISTS prompt TEXT,
  ADD COLUMN IF NOT EXISTS action_name TEXT,
  ADD COLUMN IF NOT EXISTS affected_record_id TEXT,
  ADD COLUMN IF NOT EXISTS details JSONB;

-- Migration 018 used an integer company key, while the application supports
-- both numeric and UUID tenant identifiers. Text conversion preserves every
-- existing value and permits future UUID company IDs.
DO $$
DECLARE current_type TEXT;
BEGIN
  SELECT data_type INTO current_type
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='ai_audit_logs' AND column_name='company_id';
  IF current_type IS NOT NULL AND current_type <> 'text' THEN
    ALTER TABLE public.ai_audit_logs ALTER COLUMN company_id TYPE TEXT USING company_id::text;
  END IF;
END $$;

-- Keep legacy fields for historical readers, but do not require them for new
-- structured audit events. Runtime DDL in older releases may have created the
-- newer column layout before migration 018, so guard legacy columns by name.
DO $$
DECLARE legacy_column TEXT;
BEGIN
  FOREACH legacy_column IN ARRAY ARRAY['role', 'prompt', 'action_name'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns c
                WHERE c.table_schema='public' AND c.table_name='ai_audit_logs'
                  AND c.column_name = legacy_column) THEN
      EXECUTE format('ALTER TABLE public.ai_audit_logs ALTER COLUMN %I DROP NOT NULL', legacy_column);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name='ai_audit_logs' AND c.column_name='role')
     AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name='ai_audit_logs' AND c.column_name='action_name') THEN
    UPDATE public.ai_audit_logs
       SET user_role = COALESCE(user_role, role, 'user'),
           tool_name = COALESCE(tool_name, action_name, 'LEGACY_AI_EVENT'),
           action_params = COALESCE(action_params, '{}'::jsonb)
     WHERE user_role IS NULL OR tool_name IS NULL OR action_params IS NULL;
  END IF;
END $$;

ALTER TABLE public.ai_audit_logs ALTER COLUMN user_role SET DEFAULT 'user';
ALTER TABLE public.ai_audit_logs ALTER COLUMN tool_name SET DEFAULT 'LEGACY_AI_EVENT';
ALTER TABLE public.ai_audit_logs ALTER COLUMN action_params SET DEFAULT '{}'::jsonb;
ALTER TABLE public.ai_audit_logs ALTER COLUMN status SET DEFAULT 'SUCCESS';
ALTER TABLE public.ai_audit_logs ALTER COLUMN blocked SET DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_ai_audit_logs_created_at ON public.ai_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_audit_logs_company_created ON public.ai_audit_logs(company_id, created_at DESC);

COMMIT;
