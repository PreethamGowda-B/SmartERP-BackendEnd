-- ============================================================================
-- Migration 050: Fix Security Infrastructure RLS Session Variable Settings
--
-- Rectifies RLS policies on security_events, security_incidents, and security_actions
-- to match db.js application session variables:
--   - Uses app.current_role (matches db.js set_config('app.current_role', ...))
--   - Uses app.bypass_rls IN ('on', 'true') (matches db.js set_config('app.bypass_rls', ...))
--   - Retains backward compatibility for app.current_user_role and app.bypass_rls='true'
-- ============================================================================

-- 1. Correct RLS Policies for security_events
DROP POLICY IF EXISTS sec_events_select_scoped ON security_events;
CREATE POLICY sec_events_select_scoped ON security_events
  FOR SELECT USING (
    current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.current_user_role', true) = 'super_admin'
    OR current_setting('app.bypass_rls', true) IN ('on', 'true')
    OR (company_id IS NOT NULL AND company_id = NULLIF(current_setting('app.current_company_id', true), ''))
  );

DROP POLICY IF EXISTS sec_events_no_update ON security_events;
CREATE POLICY sec_events_no_update ON security_events
  FOR UPDATE USING (
    current_setting('app.bypass_rls', true) IN ('on', 'true')
  );

DROP POLICY IF EXISTS sec_events_delete_superadmin_only ON security_events;
CREATE POLICY sec_events_delete_superadmin_only ON security_events
  FOR DELETE USING (
    current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.current_user_role', true) = 'super_admin'
    OR current_setting('app.bypass_rls', true) IN ('on', 'true')
  );

-- 2. Correct RLS Policies for security_incidents
DROP POLICY IF EXISTS sec_incidents_superadmin_all ON security_incidents;
CREATE POLICY sec_incidents_superadmin_all ON security_incidents
  FOR ALL USING (
    current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.current_user_role', true) = 'super_admin'
    OR current_setting('app.bypass_rls', true) IN ('on', 'true')
  )
  WITH CHECK (
    current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.current_user_role', true) = 'super_admin'
    OR current_setting('app.bypass_rls', true) IN ('on', 'true')
  );

DROP POLICY IF EXISTS sec_incidents_tenant_select ON security_incidents;
CREATE POLICY sec_incidents_tenant_select ON security_incidents
  FOR SELECT USING (
    company_id IS NOT NULL
    AND company_id = NULLIF(current_setting('app.current_company_id', true), '')
  );

-- 3. Correct RLS Policies for security_actions
DROP POLICY IF EXISTS sec_actions_superadmin_all ON security_actions;
CREATE POLICY sec_actions_superadmin_all ON security_actions
  FOR ALL USING (
    current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.current_user_role', true) = 'super_admin'
    OR current_setting('app.bypass_rls', true) IN ('on', 'true')
  )
  WITH CHECK (
    current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.current_user_role', true) = 'super_admin'
    OR current_setting('app.bypass_rls', true) IN ('on', 'true')
  );

DROP POLICY IF EXISTS sec_actions_tenant_select ON security_actions;
CREATE POLICY sec_actions_tenant_select ON security_actions
  FOR SELECT USING (
    company_id IS NOT NULL
    AND company_id = NULLIF(current_setting('app.current_company_id', true), '')
  );
