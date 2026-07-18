-- ===============================
-- SmartERP PostgreSQL Row-Level Security Policies
-- ⚠️  DO NOT run this automatically on startup
-- ⚠️  Test on staging first, then apply to production manually
-- ⚠️  Requires: app.current_company_id, app.bypass_rls, app.current_role
--     session variables — set by db.js via ALS on every query.
-- ===============================
--
-- ROLLOUT PLAN:
--   Step 1: Run on staging, verify all queries work
--   Step 2: Run on production during low-traffic window
--   Step 3: Monitor error logs for 24 h
--   Step 4: If issues, run the DISABLE section at the bottom
-- ===============================
--
-- FAIL-CLOSED DESIGN:
--   Default: 0 rows (no context = no access).
--   Bypass requires EXPLICIT opt-in via app.bypass_rls = 'on'.
--   An empty/null companyId is NOT treated as a bypass — it is denied.
--   Background jobs, migrations, and auth routes must explicitly set
--   app.bypass_rls via the storage.run({ bypassRls: true }) helper in db.js.
--
-- POLICY TEMPLATE (applied to every tenant-scoped table):
--   ALLOW if bypass_rls = 'on'          → cron jobs, migrations, auth lookups
--   ALLOW if current_role = 'super_admin'→ platform admin sees all companies
--   ALLOW if app.role = 'admin_bypass'   → DB-level scripts / psql shell bypass
--   ALLOW if company_id matches session  → standard tenant query
--   DENY everything else (missing ctx, wrong company, etc.)
-- ===============================

-- ── Helper: reusable inline expression ────────────────────────────────────────
-- Used in every USING clause below.  Kept as a comment template for clarity:
--
--   current_setting('app.bypass_rls',  true) = 'on'
--   OR current_setting('app.current_role', true) = 'super_admin'
--   OR current_setting('app.role', true) = 'admin_bypass'
--   OR <table>.company_id::text = current_setting('app.current_company_id', true)

-- ── inventory_items ───────────────────────────────────────────────────────────
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_company_isolation ON inventory_items;
CREATE POLICY inventory_company_isolation ON inventory_items
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR inventory_items.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── payroll ───────────────────────────────────────────────────────────────────
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_company_isolation ON payroll;
CREATE POLICY payroll_company_isolation ON payroll
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR payroll.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── jobs ─────────────────────────────────────────────────────────────────────
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS jobs_company_isolation ON jobs;
CREATE POLICY jobs_company_isolation ON jobs
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR jobs.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── attendance ────────────────────────────────────────────────────────────────
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendance_company_isolation ON attendance;
CREATE POLICY attendance_company_isolation ON attendance
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR attendance.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── notifications ─────────────────────────────────────────────────────────────
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_company_isolation ON notifications;
CREATE POLICY notifications_company_isolation ON notifications
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR notifications.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── material_requests ─────────────────────────────────────────────────────────
ALTER TABLE material_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS material_requests_company_isolation ON material_requests;
CREATE POLICY material_requests_company_isolation ON material_requests
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR material_requests.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── messages ──────────────────────────────────────────────────────────────────
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_company_isolation ON messages;
CREATE POLICY messages_company_isolation ON messages
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR messages.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── job_messages ──────────────────────────────────────────────────────────────
ALTER TABLE job_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_messages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_messages_company_isolation ON job_messages;
CREATE POLICY job_messages_company_isolation ON job_messages
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR job_messages.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── employee_documents ────────────────────────────────────────────────────────
ALTER TABLE employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_documents_company_isolation ON employee_documents;
CREATE POLICY employee_documents_company_isolation ON employee_documents
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR employee_documents.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── customers ─────────────────────────────────────────────────────────────────
-- ⚠️ Customer auth routes query this table by email BEFORE a company context is known.
--    They are protected by the bypassRls: true flag at the router level.
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customers_company_isolation ON customers;
CREATE POLICY customers_company_isolation ON customers
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR customers.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── conversations ─────────────────────────────────────────────────────────────
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversations_company_isolation ON conversations;
CREATE POLICY conversations_company_isolation ON conversations
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR conversations.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── employee_profiles ─────────────────────────────────────────────────────────
ALTER TABLE employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_profiles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_profiles_company_isolation ON employee_profiles;
CREATE POLICY employee_profiles_company_isolation ON employee_profiles
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR employee_profiles.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── activities ────────────────────────────────────────────────────────────────
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS activities_company_isolation ON activities;
CREATE POLICY activities_company_isolation ON activities
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR activities.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── company_settings ──────────────────────────────────────────────────────────
-- Note: company_id is TEXT type in this table (see workflow_enhancement_migration.sql)
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_settings_company_isolation ON company_settings;
CREATE POLICY company_settings_company_isolation ON company_settings
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR company_settings.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── sla_configs ───────────────────────────────────────────────────────────────
ALTER TABLE sla_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_configs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sla_configs_company_isolation ON sla_configs;
CREATE POLICY sla_configs_company_isolation ON sla_configs
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR sla_configs.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── invoices ──────────────────────────────────────────────────────────────────
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoices_company_isolation ON invoices;
CREATE POLICY invoices_company_isolation ON invoices
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR invoices.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── job_materials ─────────────────────────────────────────────────────────────
ALTER TABLE job_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_materials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_materials_company_isolation ON job_materials;
CREATE POLICY job_materials_company_isolation ON job_materials
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR job_materials.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── branches ──────────────────────────────────────────────────────────────────
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS branches_company_isolation ON branches;
CREATE POLICY branches_company_isolation ON branches
  USING (
    current_setting('app.bypass_rls',  true) = 'on'
    OR current_setting('app.current_role', true) = 'super_admin'
    OR current_setting('app.role', true) = 'admin_bypass'
    OR branches.company_id::text = current_setting('app.current_company_id', true)
  );

-- ── users table ───────────────────────────────────────────────────────────────
-- ⚠️ INTENTIONALLY EXCLUDED FROM RLS ⚠️
-- Auth routes (login, signup, Google OAuth, password reset, and the super-admin
-- route) query the users table by email BEFORE a company context is known.
-- The explicit bypassRls opt-in on auth routers handles this safely.
-- RLS on users is a future hardening step that requires redesigning auth to use a
-- separate, RLS-exempt DB role for credential lookups.
--
-- Until then, tenant isolation for users is enforced at the application layer
-- in every authenticated route via authenticateToken + company_id checks.

-- ===============================
-- TO DISABLE (if issues arise — run these to instantly roll back):
-- ===============================
-- ALTER TABLE inventory_items    DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE payroll             DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE jobs                DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE attendance          DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE notifications       DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE material_requests   DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE messages            DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE job_messages        DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE employee_documents  DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE customers           DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE conversations       DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE employee_profiles   DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE activities          DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE company_settings    DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE sla_configs         DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE invoices            DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE job_materials       DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE branches            DISABLE ROW LEVEL SECURITY;
-- ===============================
-- TO DROP ALL POLICIES:
-- ===============================
-- DROP POLICY IF EXISTS inventory_company_isolation       ON inventory_items;
-- DROP POLICY IF EXISTS payroll_company_isolation          ON payroll;
-- DROP POLICY IF EXISTS jobs_company_isolation             ON jobs;
-- DROP POLICY IF EXISTS attendance_company_isolation       ON attendance;
-- DROP POLICY IF EXISTS notifications_company_isolation    ON notifications;
-- DROP POLICY IF EXISTS material_requests_company_isolation ON material_requests;
-- DROP POLICY IF EXISTS messages_company_isolation         ON messages;
-- DROP POLICY IF EXISTS job_messages_company_isolation     ON job_messages;
-- DROP POLICY IF EXISTS employee_documents_company_isolation ON employee_documents;
-- DROP POLICY IF EXISTS customers_company_isolation        ON customers;
-- DROP POLICY IF EXISTS conversations_company_isolation    ON conversations;
-- DROP POLICY IF EXISTS employee_profiles_company_isolation ON employee_profiles;
-- DROP POLICY IF EXISTS activities_company_isolation       ON activities;
-- DROP POLICY IF EXISTS company_settings_company_isolation ON company_settings;
-- DROP POLICY IF EXISTS sla_configs_company_isolation      ON sla_configs;
-- DROP POLICY IF EXISTS invoices_company_isolation         ON invoices;
-- DROP POLICY IF EXISTS job_materials_company_isolation    ON job_materials;
-- DROP POLICY IF EXISTS branches_company_isolation         ON branches;
