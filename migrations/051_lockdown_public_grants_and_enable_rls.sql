-- ============================================================================
-- Migration 051 (Hardened): Lockdown PUBLIC/Data-API Grants, Role-Based
-- Super Admin & Bypass Isolation, Auth Secret Protection, and Full RLS
--
-- Security Model:
--   - postgres (BYPASSRLS=true): trusted server-side bypass (auth lookup, jobs)
--   - smarterp_superadmin (NOLOGIN, NOBYPASSRLS): cross-tenant Super Admin role
--     (granted ONLY to postgres; smarterp_app cannot SET ROLE smarterp_superadmin)
--   - smarterp_app (LOGIN, NOBYPASSRLS): standard tenant-scoped app role
--   - PUBLIC / anon / authenticated: ZERO access to public schema objects
--   - Policies NEVER trust client-settable app.bypass_rls or app.current_role
--   - Auth secrets (refresh_tokens, customer_refresh_tokens, email_otps, "User",
--     api_tokens, user_devices) are denied to smarterp_superadmin.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Create trusted smarterp_superadmin role (member of postgres, NOT smarterp_app)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smarterp_superadmin') THEN
    CREATE ROLE smarterp_superadmin NOLOGIN NOBYPASSRLS;
  END IF;
  GRANT smarterp_superadmin TO postgres;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smarterp_app') THEN
    REVOKE smarterp_superadmin FROM smarterp_app;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Revoke ALL privileges from PUBLIC, anon, and authenticated in public
--    and grant schema/table/sequence usage to smarterp_superadmin & smarterp_app
-- ----------------------------------------------------------------------------
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;

  -- Lock down default privileges for BOTH postgres and supabase_admin
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    BEGIN
      ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
      FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
          EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
          EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
        END IF;
      END LOOP;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin (insufficient_privilege)';
    END;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO smarterp_superadmin;
GRANT ALL ON ALL TABLES IN SCHEMA public TO smarterp_superadmin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO smarterp_superadmin;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO smarterp_superadmin;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO smarterp_superadmin;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smarterp_app') THEN
    GRANT USAGE ON SCHEMA public TO smarterp_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA public TO service_role;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Fix conflicting / GUC-bypassable policies on existing RLS-enabled tables
-- ----------------------------------------------------------------------------

-- 3a. biometric_devices: fix unsafe ::integer cast and remove GUC bypass
ALTER TABLE public.biometric_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS biometric_devices_isolation ON public.biometric_devices;
DROP POLICY IF EXISTS biometric_devices_tenant_isolation ON public.biometric_devices;
CREATE POLICY biometric_devices_tenant_isolation ON public.biometric_devices
  FOR ALL USING (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
  )
  WITH CHECK (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
  );

-- 3b. job_actions: had RLS enabled with 0 policies
DROP POLICY IF EXISTS job_actions_tenant_isolation ON public.job_actions;
CREATE POLICY job_actions_tenant_isolation ON public.job_actions
  FOR ALL USING (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
  )
  WITH CHECK (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
  );

-- 3c. security_events / security_incidents / security_actions: role-based superadmin
DROP POLICY IF EXISTS sec_events_insert_all ON public.security_events;
DROP POLICY IF EXISTS sec_events_insert_scoped ON public.security_events;
CREATE POLICY sec_events_insert_scoped ON public.security_events
  FOR INSERT WITH CHECK (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id = NULLIF(current_setting('app.current_company_id', true), ''))
  );

DROP POLICY IF EXISTS sec_events_select_scoped ON public.security_events;
CREATE POLICY sec_events_select_scoped ON public.security_events
  FOR SELECT USING (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id = NULLIF(current_setting('app.current_company_id', true), ''))
  );

DROP POLICY IF EXISTS sec_events_no_update ON public.security_events;
CREATE POLICY sec_events_no_update ON public.security_events
  FOR UPDATE USING (false);

DROP POLICY IF EXISTS sec_events_delete_superadmin_only ON public.security_events;
CREATE POLICY sec_events_delete_superadmin_only ON public.security_events
  FOR DELETE USING (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'));

DROP POLICY IF EXISTS sec_incidents_superadmin_all ON public.security_incidents;
CREATE POLICY sec_incidents_superadmin_all ON public.security_incidents
  FOR ALL USING (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
  WITH CHECK (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'));

DROP POLICY IF EXISTS sec_actions_superadmin_all ON public.security_actions;
CREATE POLICY sec_actions_superadmin_all ON public.security_actions
  FOR ALL USING (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
  WITH CHECK (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'));

-- 3d. subscription/storage tables: remove client-settable app.bypass_rls
DROP POLICY IF EXISTS company_storage_usage_tenant ON public.company_storage_usage;
CREATE POLICY company_storage_usage_tenant ON public.company_storage_usage
  FOR ALL USING (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
  )
  WITH CHECK (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
  );

DROP POLICY IF EXISTS subscription_payment_attempts_tenant ON public.subscription_payment_attempts;
CREATE POLICY subscription_payment_attempts_tenant ON public.subscription_payment_attempts
  FOR ALL USING (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
  )
  WITH CHECK (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
  );

DROP POLICY IF EXISTS subscription_payments_tenant ON public.subscription_payments;
CREATE POLICY subscription_payments_tenant ON public.subscription_payments
  FOR ALL USING (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
  )
  WITH CHECK (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
  );

-- ----------------------------------------------------------------------------
-- 4. Authentication Secrets & Legacy Tables:
--    DENIED to both smarterp_app AND smarterp_superadmin!
--    Accessible ONLY to postgres (BYPASSRLS=true) during trusted auth flows.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User', 'Job', 'companies_old', 'playing_with_neon',
    'refresh_tokens', 'customer_refresh_tokens', 'email_otps'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_bypass_only', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_deny_non_bypass', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING (false) WITH CHECK (false)',
      t || '_deny_non_bypass', t
    );
  END LOOP;
END $$;

-- api_tokens: strict company_id isolation ONLY (no superadmin access)
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_tokens_tenant_isolation ON public.api_tokens;
CREATE POLICY api_tokens_tenant_isolation ON public.api_tokens
  FOR ALL USING (
    company_id IS NOT NULL
    AND company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
  )
  WITH CHECK (
    company_id IS NOT NULL
    AND company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
  );

-- user_devices: strict owner user_id isolation ONLY (no superadmin access)
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_devices_owner_or_bypass ON public.user_devices;
DROP POLICY IF EXISTS user_devices_owner_only ON public.user_devices;
CREATE POLICY user_devices_owner_only ON public.user_devices
  FOR ALL USING (
    user_id IS NOT NULL
    AND user_id::text = NULLIF(current_setting('app.current_user_id', true), '')
  )
  WITH CHECK (
    user_id IS NOT NULL
    AND user_id::text = NULLIF(current_setting('app.current_user_id', true), '')
  );

-- ----------------------------------------------------------------------------
-- 5. Company-scoped tables (57 tables, excluding biometric_devices & api_tokens)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'account_deletion_audit', 'ai_action_audit_trail', 'ai_audit_logs', 'ai_company_memory',
    'amc_contracts', 'audit_logs', 'automation_rules',
    'branches', 'cnc_alarm_kb', 'cnc_vendors', 'companies', 'company_settings',
    'conversations', 'customer_favorite_employees', 'customer_machine_documents',
    'customer_machines', 'customer_plants', 'engineer_routes', 'error_logs', 'feedback',
    'hr_assets', 'hr_audit_logs', 'hr_employee_requests', 'hr_exit_management',
    'hr_leave_balances', 'hr_performance_reviews', 'hr_recruitment_candidates',
    'hr_roster_shifts', 'hr_safety_incidents', 'hr_skills_certifications',
    'inventory', 'job_action_requests', 'job_assignments', 'job_audit_logs',
    'job_costing', 'job_materials', 'job_messages', 'job_proof_of_work', 'job_reviews',
    'leave_requests', 'machine_subcomponents', 'machine_timeline_events',
    'message_attachments', 'notification_preferences', 'predictive_alerts',
    'purchase_orders', 'recurring_jobs', 'remote_support_sessions', 'saas_subscriptions',
    'service_checklist_templates', 'service_quotations', 'sla_configs',
    'subscription_notification_logs', 'warranty_claims', 'work_requests',
    'workforce_gatekeeper_audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL ' ||
      'USING (pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'') OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting(''app.current_company_id'', true), ''''))) ' ||
      'WITH CHECK (pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'') OR (company_id IS NOT NULL AND company_id::text = NULLIF(current_setting(''app.current_company_id'', true), '''')))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 6. Child / Auxiliary tables without company_id (8 tables) + global plans (1)
-- ----------------------------------------------------------------------------
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_read_all ON public.plans;
DROP POLICY IF EXISTS plans_admin_write ON public.plans;
CREATE POLICY plans_read_all ON public.plans FOR SELECT USING (true);
CREATE POLICY plans_admin_write ON public.plans
  FOR ALL USING (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'))
  WITH CHECK (pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER'));

ALTER TABLE public.attendance_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attendance_corrections_tenant_isolation ON public.attendance_corrections;
CREATE POLICY attendance_corrections_tenant_isolation ON public.attendance_corrections
  FOR ALL USING (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR EXISTS (
      SELECT 1 FROM public.attendance a
      WHERE a.id = attendance_corrections.attendance_id
        AND a.company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
    )
  )
  WITH CHECK (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR EXISTS (
      SELECT 1 FROM public.attendance a
      WHERE a.id = attendance_corrections.attendance_id
        AND a.company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
    )
  );

ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_participants_tenant_isolation ON public.conversation_participants;
CREATE POLICY conversation_participants_tenant_isolation ON public.conversation_participants
  FOR ALL USING (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_participants.conversation_id
        AND c.company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
    )
  )
  WITH CHECK (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_participants.conversation_id
        AND c.company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
    )
  );

ALTER TABLE public.inventory_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_history_tenant_isolation ON public.inventory_history;
CREATE POLICY inventory_history_tenant_isolation ON public.inventory_history
  FOR ALL USING (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR EXISTS (
      SELECT 1 FROM public.inventory i
      WHERE i.id::text = inventory_history.inventory_item_id::text
        AND i.company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
    )
  )
  WITH CHECK (
    pg_has_role(current_user, 'smarterp_superadmin', 'MEMBER')
    OR EXISTS (
      SELECT 1 FROM public.inventory i
      WHERE i.id::text = inventory_history.inventory_item_id::text
        AND i.company_id::text = NULLIF(current_setting('app.current_company_id', true), '')
    )
  );

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['expense_requests', 'shifts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL ' ||
      'USING (pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'') OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = %I.employee_id AND u.company_id::text = NULLIF(current_setting(''app.current_company_id'', true), ''''))) ' ||
      'WITH CHECK (pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'') OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = %I.employee_id AND u.company_id::text = NULLIF(current_setting(''app.current_company_id'', true), '''')))',
      t || '_tenant_isolation', t, t, t
    );
  END LOOP;

  FOREACH t IN ARRAY ARRAY['message_read_receipts', 'pinned_conversations', 'chat_reactions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_user_or_bypass', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL ' ||
      'USING (pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'') OR (user_id IS NOT NULL AND user_id::text = NULLIF(current_setting(''app.current_user_id'', true), ''''))) ' ||
      'WITH CHECK (pg_has_role(current_user, ''smarterp_superadmin'', ''MEMBER'') OR (user_id IS NOT NULL AND user_id::text = NULLIF(current_setting(''app.current_user_id'', true), '''')))',
      t || '_user_or_bypass', t
    );
  END LOOP;
END $$;

COMMIT;
