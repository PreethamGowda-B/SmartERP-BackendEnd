-- ============================================================================
-- Rollback for Migration 051 (Hardened): Restore pre-051 RLS/policy state
--
-- SAFETY NOTE: Does NOT re-grant privileges to PUBLIC, anon, or authenticated.
-- ============================================================================

BEGIN;

-- 1. Restore pre-051 policies on existing RLS-enabled tables
DROP POLICY IF EXISTS biometric_devices_tenant_isolation ON public.biometric_devices;
CREATE POLICY biometric_devices_isolation ON public.biometric_devices
  FOR ALL USING (company_id = (current_setting('app.current_company_id', true))::integer);

DROP POLICY IF EXISTS job_actions_tenant_isolation ON public.job_actions;

DROP POLICY IF EXISTS sec_events_insert_scoped ON public.security_events;
CREATE POLICY sec_events_insert_all ON public.security_events FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS sec_events_select_scoped ON public.security_events;
CREATE POLICY sec_events_select_scoped ON public.security_events
  FOR SELECT USING (
    current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.current_user_role', true) = 'super_admin'
    OR current_setting('app.bypass_rls', true) IN ('on', 'true')
    OR (company_id IS NOT NULL AND company_id = NULLIF(current_setting('app.current_company_id', true), ''))
  );

DROP POLICY IF EXISTS sec_events_no_update ON public.security_events;
CREATE POLICY sec_events_no_update ON public.security_events
  FOR UPDATE USING (current_setting('app.bypass_rls', true) IN ('on', 'true'));

DROP POLICY IF EXISTS sec_events_delete_superadmin_only ON public.security_events;
CREATE POLICY sec_events_delete_superadmin_only ON public.security_events
  FOR DELETE USING (
    current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.current_user_role', true) = 'super_admin'
    OR current_setting('app.bypass_rls', true) IN ('on', 'true')
  );

DROP POLICY IF EXISTS sec_incidents_superadmin_all ON public.security_incidents;
CREATE POLICY sec_incidents_superadmin_all ON public.security_incidents
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

DROP POLICY IF EXISTS sec_actions_superadmin_all ON public.security_actions;
CREATE POLICY sec_actions_superadmin_all ON public.security_actions
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

DROP POLICY IF EXISTS company_storage_usage_tenant ON public.company_storage_usage;
CREATE POLICY company_storage_usage_tenant ON public.company_storage_usage
  FOR ALL USING (
    (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
    OR (COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true')
  )
  WITH CHECK (
    (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
    OR (COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true')
  );

DROP POLICY IF EXISTS subscription_payment_attempts_tenant ON public.subscription_payment_attempts;
CREATE POLICY subscription_payment_attempts_tenant ON public.subscription_payment_attempts
  FOR ALL USING (
    (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
    OR (COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true')
  )
  WITH CHECK (
    (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
    OR (COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true')
  );

DROP POLICY IF EXISTS subscription_payments_tenant ON public.subscription_payments;
CREATE POLICY subscription_payments_tenant ON public.subscription_payments
  FOR ALL USING (
    (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
    OR (COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true')
  )
  WITH CHECK (
    (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''))
    OR (COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true')
  );

-- 2. Drop 051 policies and disable RLS on the 75 newly-enabled tables
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User', 'Job', 'companies_old', 'playing_with_neon',
    'refresh_tokens', 'customer_refresh_tokens', 'email_otps'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_deny_non_bypass', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;

  DROP POLICY IF EXISTS api_tokens_tenant_isolation ON public.api_tokens;
  ALTER TABLE public.api_tokens DISABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS user_devices_owner_only ON public.user_devices;
  ALTER TABLE public.user_devices DISABLE ROW LEVEL SECURITY;

  FOREACH t IN ARRAY ARRAY[
    'account_deletion_audit', 'ai_action_audit_trail', 'ai_audit_logs', 'ai_company_memory',
    'amc_contracts', 'audit_logs', 'automation_rules', 'biometric_devices',
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
    IF t <> 'biometric_devices' THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
    END IF;
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;

  DROP POLICY IF EXISTS plans_read_all ON public.plans;
  DROP POLICY IF EXISTS plans_admin_write ON public.plans;
  ALTER TABLE public.plans DISABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS attendance_corrections_tenant_isolation ON public.attendance_corrections;
  ALTER TABLE public.attendance_corrections DISABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS conversation_participants_tenant_isolation ON public.conversation_participants;
  ALTER TABLE public.conversation_participants DISABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS inventory_history_tenant_isolation ON public.inventory_history;
  ALTER TABLE public.inventory_history DISABLE ROW LEVEL SECURITY;

  FOREACH t IN ARRAY ARRAY['expense_requests', 'shifts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['message_read_receipts', 'pinned_conversations', 'chat_reactions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_user_or_bypass', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

COMMIT;
