-- ============================================================================
-- Rollback for Migration 054: Restore Legacy 011 Policies on 9 Core Tables
-- (Only use if an emergency rollback is required; restores 011-style policies)
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
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL USING (' ||
        'current_setting(''app.bypass_rls'', true) = ''on'' ' ||
        'OR current_setting(''app.current_role'', true) = ''super_admin'' ' ||
        'OR current_setting(''app.role'', true) = ''admin_bypass'' ' ||
        'OR company_id::text = NULLIF(current_setting(''app.current_company_id'', true), '''')' ||
        ')',
        'rls_tenant_isolation_' || t, t
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
