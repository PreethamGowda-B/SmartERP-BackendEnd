-- ============================================================================
-- Migration 052: Resolve Supabase Security & Performance Advisor Warnings
--                (Function Search Path, Multiple Permissive Policies, InitPlan)
--
-- Note: Duplicate index cleanup is separated into Migration 053
--       (053_drop_duplicate_indexes.sql) for independent maintenance execution.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Fix mutable search_path on production_reject_history_mutation()
-- ----------------------------------------------------------------------------
ALTER FUNCTION public.production_reject_history_mutation()
  SET search_path = pg_catalog, public;

-- ----------------------------------------------------------------------------
-- 2. Consolidate Multiple Permissive Policies (10 tables)
-- ----------------------------------------------------------------------------

-- 2a. Legacy 5 tables: drop redundant *_isolation_policy + GUC-bypassable rls_tenant_isolation_*
--     Replace with singleInitPlan-wrapped role-based tenant isolation policy
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activities', 'inventory_items', 'material_requests', 'notifications', 'users'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_isolation_policy', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'rls_tenant_isolation_' || t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL ' ||
      'USING ((SELECT pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'')) OR (company_id IS NOT NULL AND company_id::text = NULLIF((SELECT current_setting(''app.current_company_id'', true)), ''''))) ' ||
      'WITH CHECK ((SELECT pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'')) OR (company_id IS NOT NULL AND company_id::text = NULLIF((SELECT current_setting(''app.current_company_id'', true)), '''')))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- 2b. announcements: 1 policy per command (no overlapping ALL + per-command)
DROP POLICY IF EXISTS smarterp_041_announcements_superadmin ON public.announcements;
DROP POLICY IF EXISTS smarterp_041_announcements_company_read ON public.announcements;
DROP POLICY IF EXISTS smarterp_041_announcements_company_insert ON public.announcements;
DROP POLICY IF EXISTS smarterp_041_announcements_company_delete ON public.announcements;
DROP POLICY IF EXISTS announcements_select_policy ON public.announcements;
DROP POLICY IF EXISTS announcements_insert_policy ON public.announcements;
DROP POLICY IF EXISTS announcements_update_policy ON public.announcements;
DROP POLICY IF EXISTS announcements_delete_policy ON public.announcements;

CREATE POLICY announcements_select_policy ON public.announcements
  FOR SELECT USING (
    (SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
    OR (company_id IS NOT NULL AND company_id::text = NULLIF((SELECT current_setting('app.current_company_id', true)), ''))
  );
CREATE POLICY announcements_insert_policy ON public.announcements
  FOR INSERT WITH CHECK (
    (SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
    OR (
      company_id IS NOT NULL
      AND company_id::text = NULLIF((SELECT current_setting('app.current_company_id', true)), '')
      AND (SELECT current_setting('app.current_role', true)) = ANY (ARRAY['owner', 'admin', 'hr'])
    )
  );
CREATE POLICY announcements_update_policy ON public.announcements
  FOR UPDATE USING ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')))
  WITH CHECK ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));
CREATE POLICY announcements_delete_policy ON public.announcements
  FOR DELETE USING (
    (SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
    OR (
      company_id IS NOT NULL
      AND company_id::text = NULLIF((SELECT current_setting('app.current_company_id', true)), '')
      AND (SELECT current_setting('app.current_role', true)) = ANY (ARRAY['owner', 'admin', 'hr'])
    )
  );

-- 2c. system_settings: separate SELECT from INSERT/UPDATE/DELETE
DROP POLICY IF EXISTS smarterp_041_system_settings_superadmin ON public.system_settings;
DROP POLICY IF EXISTS smarterp_041_maintenance_status_read ON public.system_settings;
DROP POLICY IF EXISTS system_settings_select_policy ON public.system_settings;
DROP POLICY IF EXISTS system_settings_insert_policy ON public.system_settings;
DROP POLICY IF EXISTS system_settings_update_policy ON public.system_settings;
DROP POLICY IF EXISTS system_settings_delete_policy ON public.system_settings;

CREATE POLICY system_settings_select_policy ON public.system_settings
  FOR SELECT USING (
    (SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
    OR (key::text = 'maintenance_mode' AND COALESCE((SELECT current_setting('app.current_role', true)), '') = '')
  );
CREATE POLICY system_settings_insert_policy ON public.system_settings
  FOR INSERT WITH CHECK ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));
CREATE POLICY system_settings_update_policy ON public.system_settings
  FOR UPDATE USING ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')))
  WITH CHECK ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));
CREATE POLICY system_settings_delete_policy ON public.system_settings
  FOR DELETE USING ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));

-- 2d. plans: keep SELECT open to app roles, restrict INSERT/UPDATE/DELETE to superadmin
DROP POLICY IF EXISTS plans_admin_write ON public.plans;
DROP POLICY IF EXISTS plans_admin_insert ON public.plans;
DROP POLICY IF EXISTS plans_admin_update ON public.plans;
DROP POLICY IF EXISTS plans_admin_delete ON public.plans;
CREATE POLICY plans_admin_insert ON public.plans
  FOR INSERT WITH CHECK ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));
CREATE POLICY plans_admin_update ON public.plans
  FOR UPDATE USING ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')))
  WITH CHECK ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));
CREATE POLICY plans_admin_delete ON public.plans
  FOR DELETE USING ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));

-- 2e. security_incidents & security_actions: 1 policy per command
DROP POLICY IF EXISTS sec_incidents_superadmin_all ON public.security_incidents;
DROP POLICY IF EXISTS sec_incidents_tenant_select ON public.security_incidents;
DROP POLICY IF EXISTS sec_incidents_select_policy ON public.security_incidents;
DROP POLICY IF EXISTS sec_incidents_insert_policy ON public.security_incidents;
DROP POLICY IF EXISTS sec_incidents_update_policy ON public.security_incidents;
DROP POLICY IF EXISTS sec_incidents_delete_policy ON public.security_incidents;
CREATE POLICY sec_incidents_select_policy ON public.security_incidents
  FOR SELECT USING (
    (SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
    OR (company_id IS NOT NULL AND company_id = NULLIF((SELECT current_setting('app.current_company_id', true)), ''))
  );
CREATE POLICY sec_incidents_insert_policy ON public.security_incidents
  FOR INSERT WITH CHECK ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));
CREATE POLICY sec_incidents_update_policy ON public.security_incidents
  FOR UPDATE USING ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')))
  WITH CHECK ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));
CREATE POLICY sec_incidents_delete_policy ON public.security_incidents
  FOR DELETE USING ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));

DROP POLICY IF EXISTS sec_actions_superadmin_all ON public.security_actions;
DROP POLICY IF EXISTS sec_actions_tenant_select ON public.security_actions;
DROP POLICY IF EXISTS sec_actions_select_policy ON public.security_actions;
DROP POLICY IF EXISTS sec_actions_insert_policy ON public.security_actions;
DROP POLICY IF EXISTS sec_actions_update_policy ON public.security_actions;
DROP POLICY IF EXISTS sec_actions_delete_policy ON public.security_actions;
CREATE POLICY sec_actions_select_policy ON public.security_actions
  FOR SELECT USING (
    (SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
    OR (company_id IS NOT NULL AND company_id = NULLIF((SELECT current_setting('app.current_company_id', true)), ''))
  );
CREATE POLICY sec_actions_insert_policy ON public.security_actions
  FOR INSERT WITH CHECK ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));
CREATE POLICY sec_actions_update_policy ON public.security_actions
  FOR UPDATE USING ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')))
  WITH CHECK ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));
CREATE POLICY sec_actions_delete_policy ON public.security_actions
  FOR DELETE USING ((SELECT pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')));

-- ----------------------------------------------------------------------------
-- 3. Auth RLS Initialization Plan: wrap current_setting(...) and pg_has_role(...)
--    in (SELECT ...) across all remaining public policies
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  p record;
  new_qual text;
  new_wc text;
  stmt text;
BEGIN
  FOR p IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        (qual IS NOT NULL AND qual ~ 'current_setting\(' AND qual !~ '\(\s*SELECT\s+current_setting\(')
        OR (with_check IS NOT NULL AND with_check ~ 'current_setting\(' AND with_check !~ '\(\s*SELECT\s+current_setting\(')
        OR (qual IS NOT NULL AND qual ~ 'pg_has_role\(' AND qual !~ '\(\s*SELECT\s+pg_has_role\(')
        OR (with_check IS NOT NULL AND with_check ~ 'pg_has_role\(' AND with_check !~ '\(\s*SELECT\s+pg_has_role\(')
      )
  LOOP
    new_qual := p.qual;
    new_wc := p.with_check;

    IF new_qual IS NOT NULL THEN
      new_qual := regexp_replace(new_qual, '(?<!\(\s*SELECT\s+)current_setting\(([^)]+)\)', '(SELECT current_setting(\1))', 'gi');
      new_qual := regexp_replace(new_qual, '(?<!\(\s*SELECT\s+)pg_has_role\(([^)]+)\)', '(SELECT pg_has_role(\1))', 'gi');
    END IF;
    IF new_wc IS NOT NULL THEN
      new_wc := regexp_replace(new_wc, '(?<!\(\s*SELECT\s+)current_setting\(([^)]+)\)', '(SELECT current_setting(\1))', 'gi');
      new_wc := regexp_replace(new_wc, '(?<!\(\s*SELECT\s+)pg_has_role\(([^)]+)\)', '(SELECT pg_has_role(\1))', 'gi');
    END IF;

    stmt := format('ALTER POLICY %I ON public.%I', p.policyname, p.tablename);
    IF new_qual IS NOT NULL THEN
      stmt := stmt || format(' USING (%s)', new_qual);
    END IF;
    IF new_wc IS NOT NULL THEN
      stmt := stmt || format(' WITH CHECK (%s)', new_wc);
    END IF;
    EXECUTE stmt;
  END LOOP;
END $$;

COMMIT;
