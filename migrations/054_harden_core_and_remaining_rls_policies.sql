-- ============================================================================
-- Migration 054: Harden Remaining 9 Core Tables Against GUC-Bypassable RLS
--
-- Background:
--   Migration 011 created `rls_tenant_isolation_<table>` policies on 14 core
--   tables using client-settable GUCs (`app.bypass_rls`, `app.current_role`,
--   `app.role = 'admin_bypass'`).
--   Migration 052 hardened 5 of those 14 tables (`activities`,
--   `inventory_items`, `material_requests`, `notifications`, `users`).
--   This migration hardens the remaining 9 core tables so that `smarterp_app`
--   cannot bypass tenant isolation or impersonate `super_admin` via `SET`/`set_config`.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jobs',
    'attendance',
    'payroll',
    'messages',
    'employee_profiles',
    'employee_documents',
    'subscriptions',
    'subscription_events',
    'customers'
  ] LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = t
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'rls_tenant_isolation_' || t, t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_isolation_policy', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL ' ||
        'USING ((SELECT pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'')) OR (company_id IS NOT NULL AND company_id::text = NULLIF((SELECT current_setting(''app.current_company_id'', true)), ''''))) ' ||
        'WITH CHECK ((SELECT pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'')) OR (company_id IS NOT NULL AND company_id::text = NULLIF((SELECT current_setting(''app.current_company_id'', true)), '''')))',
        t || '_tenant_isolation', t
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
