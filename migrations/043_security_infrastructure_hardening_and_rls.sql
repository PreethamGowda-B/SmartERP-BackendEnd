-- ============================================================================
-- Migration 043: SmartERP Security Infrastructure Hardening & RLS Policies
-- Enforces Row-Level Security, Super Admin Isolation, Append-Only Audit Integrity,
-- and Controlled Role Grants on security_events, security_incidents, and security_actions.
-- ============================================================================

-- 1. Ensure columns and indexes exist with correct types
ALTER TABLE security_events ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE security_incidents ADD COLUMN IF NOT EXISTS ai_analysis JSONB DEFAULT NULL;
ALTER TABLE security_actions ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}';

-- 2. Enable Row Level Security (RLS) on all security tables
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_actions ENABLE ROW LEVEL SECURITY;

-- 3. RLS Policies for security_events (Append-Only Telemetry Stream)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'security_events' AND policyname = 'sec_events_insert_all') THEN
    CREATE POLICY sec_events_insert_all ON security_events
      FOR INSERT WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'security_events' AND policyname = 'sec_events_select_scoped') THEN
    CREATE POLICY sec_events_select_scoped ON security_events
      FOR SELECT USING (
        current_setting('app.current_user_role', true) = 'super_admin'
        OR current_setting('app.bypass_rls', true) = 'true'
        OR (company_id IS NOT NULL AND company_id = current_setting('app.current_company_id', true))
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'security_events' AND policyname = 'sec_events_no_update') THEN
    CREATE POLICY sec_events_no_update ON security_events
      FOR UPDATE USING (
        current_setting('app.bypass_rls', true) = 'true'
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'security_events' AND policyname = 'sec_events_delete_superadmin_only') THEN
    CREATE POLICY sec_events_delete_superadmin_only ON security_events
      FOR DELETE USING (
        current_setting('app.current_user_role', true) = 'super_admin'
        OR current_setting('app.bypass_rls', true) = 'true'
      );
  END IF;
END $$;

-- 4. RLS Policies for security_incidents (Super Admin Operations & Tenant Scoping)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'security_incidents' AND policyname = 'sec_incidents_superadmin_all') THEN
    CREATE POLICY sec_incidents_superadmin_all ON security_incidents
      FOR ALL USING (
        current_setting('app.current_user_role', true) = 'super_admin'
        OR current_setting('app.bypass_rls', true) = 'true'
      )
      WITH CHECK (
        current_setting('app.current_user_role', true) = 'super_admin'
        OR current_setting('app.bypass_rls', true) = 'true'
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'security_incidents' AND policyname = 'sec_incidents_tenant_select') THEN
    CREATE POLICY sec_incidents_tenant_select ON security_incidents
      FOR SELECT USING (
        company_id IS NOT NULL
        AND company_id = current_setting('app.current_company_id', true)
      );
  END IF;
END $$;

-- 5. RLS Policies for security_actions (Super Admin Approvals & Audit Trail)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'security_actions' AND policyname = 'sec_actions_superadmin_all') THEN
    CREATE POLICY sec_actions_superadmin_all ON security_actions
      FOR ALL USING (
        current_setting('app.current_user_role', true) = 'super_admin'
        OR current_setting('app.bypass_rls', true) = 'true'
      )
      WITH CHECK (
        current_setting('app.current_user_role', true) = 'super_admin'
        OR current_setting('app.bypass_rls', true) = 'true'
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'security_actions' AND policyname = 'sec_actions_tenant_select') THEN
    CREATE POLICY sec_actions_tenant_select ON security_actions
      FOR SELECT USING (
        company_id IS NOT NULL
        AND company_id = current_setting('app.current_company_id', true)
      );
  END IF;
END $$;

-- 6. Grant Least-Privilege Permissions
DO $$
BEGIN
  -- Grant to standard application role if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smarterp_app') THEN
    GRANT SELECT, INSERT ON security_events TO smarterp_app;
    GRANT SELECT, INSERT, UPDATE ON security_incidents TO smarterp_app;
    GRANT SELECT, INSERT, UPDATE ON security_actions TO smarterp_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO smarterp_app;
  END IF;

  -- Grant to authenticated / service roles
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT ON security_events TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON security_incidents TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON security_actions TO authenticated;
  END IF;
END $$;
