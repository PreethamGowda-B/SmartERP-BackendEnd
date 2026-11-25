-- ============================================================================
-- Rollback for Migration 052
-- Restores function search_path and all pre-052 policies on the 10
-- consolidated tables (activities, announcements, inventory_items,
-- material_requests, notifications, plans, security_actions,
-- security_incidents, system_settings, users).
-- ============================================================================

BEGIN;

ALTER FUNCTION public.production_reject_history_mutation() RESET search_path;

-- 1. Restore legacy 5 tables (activities, inventory_items, material_requests, notifications, users)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activities', 'inventory_items', 'material_requests', 'notifications', 'users'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING (company_id::text = current_setting(''app.current_company_id'', true))',
      t || '_isolation_policy', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING (' ||
      'current_setting(''app.bypass_rls'', true) = ''on'' ' ||
      'OR current_setting(''app.current_role'', true) = ''super_admin'' ' ||
      'OR current_setting(''app.role'', true) = ''admin_bypass'' ' ||
      'OR company_id::text = NULLIF(current_setting(''app.current_company_id'', true), ''''))',
      'rls_tenant_isolation_' || t, t
    );
  END LOOP;
END $$;

-- 2. Restore announcements
DROP POLICY IF EXISTS announcements_select_policy ON public.announcements;
DROP POLICY IF EXISTS announcements_insert_policy ON public.announcements;
DROP POLICY IF EXISTS announcements_update_policy ON public.announcements;
DROP POLICY IF EXISTS announcements_delete_policy ON public.announcements;

CREATE POLICY smarterp_041_announcements_superadmin ON public.announcements
  FOR ALL USING (current_setting('app.current_role', true) = 'super_admin')
  WITH CHECK (current_setting('app.current_role', true) = 'super_admin');
CREATE POLICY smarterp_041_announcements_company_read ON public.announcements
  FOR SELECT USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));
CREATE POLICY smarterp_041_announcements_company_insert ON public.announcements
  FOR INSERT WITH CHECK (
    company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
    AND current_setting('app.current_role', true) = ANY (ARRAY['owner', 'admin', 'hr'])
  );
CREATE POLICY smarterp_041_announcements_company_delete ON public.announcements
  FOR DELETE USING (
    company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
    AND current_setting('app.current_role', true) = ANY (ARRAY['owner', 'admin', 'hr'])
  );

-- 3. Restore system_settings
DROP POLICY IF EXISTS system_settings_select_policy ON public.system_settings;
DROP POLICY IF EXISTS system_settings_insert_policy ON public.system_settings;
DROP POLICY IF EXISTS system_settings_update_policy ON public.system_settings;
DROP POLICY IF EXISTS system_settings_delete_policy ON public.system_settings;

CREATE POLICY smarterp_041_system_settings_superadmin ON public.system_settings
  FOR ALL USING (current_setting('app.current_role', true) = 'super_admin')
  WITH CHECK (current_setting('app.current_role', true) = 'super_admin');
CREATE POLICY smarterp_041_maintenance_status_read ON public.system_settings
  FOR SELECT USING (
    current_setting('app.current_role', true) = 'super_admin'
    OR (key::text = 'maintenance_mode' AND COALESCE(current_setting('app.current_role', true), '') = '')
  );

-- 4. Restore plans
DROP POLICY IF EXISTS plans_admin_insert ON public.plans;
DROP POLICY IF EXISTS plans_admin_update ON public.plans;
DROP POLICY IF EXISTS plans_admin_delete ON public.plans;
CREATE POLICY plans_admin_write ON public.plans
  FOR ALL USING (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
  WITH CHECK (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'));

-- 5. Restore security_incidents & security_actions
DROP POLICY IF EXISTS sec_incidents_select_policy ON public.security_incidents;
DROP POLICY IF EXISTS sec_incidents_insert_policy ON public.security_incidents;
DROP POLICY IF EXISTS sec_incidents_update_policy ON public.security_incidents;
DROP POLICY IF EXISTS sec_incidents_delete_policy ON public.security_incidents;
CREATE POLICY sec_incidents_superadmin_all ON public.security_incidents
  FOR ALL USING (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
  WITH CHECK (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'));
CREATE POLICY sec_incidents_tenant_select ON public.security_incidents
  FOR SELECT USING (company_id IS NOT NULL AND company_id = NULLIF(current_setting('app.current_company_id', true), ''));

DROP POLICY IF EXISTS sec_actions_select_policy ON public.security_actions;
DROP POLICY IF EXISTS sec_actions_insert_policy ON public.security_actions;
DROP POLICY IF EXISTS sec_actions_update_policy ON public.security_actions;
DROP POLICY IF EXISTS sec_actions_delete_policy ON public.security_actions;
CREATE POLICY sec_actions_superadmin_all ON public.security_actions
  FOR ALL USING (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
  WITH CHECK (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'));
CREATE POLICY sec_actions_tenant_select ON public.security_actions
  FOR SELECT USING (company_id IS NOT NULL AND company_id = NULLIF(current_setting('app.current_company_id', true), ''));

COMMIT;
