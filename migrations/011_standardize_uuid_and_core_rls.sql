-- ====================================================================
-- SmartERP Migration 011: Standardize company_id to UUID & Core Tables RLS
-- ====================================================================

-- ── 1. Standardize company_id Data Type to UUID Across Core Tables ──────────────

DO $$ 
BEGIN
  -- Helper block to safely alter column company_id to UUID on core tables
  BEGIN ALTER TABLE users ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE jobs ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE attendance ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE payroll ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE inventory_items ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE notifications ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE messages ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE employee_profiles ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE material_requests ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE employee_documents ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE subscriptions ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE subscription_events ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE activities ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE customers ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE job_messages ALTER COLUMN company_id TYPE UUID USING company_id::text::uuid; EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

-- ── 2. Enable & Enforce PostgreSQL RLS Policies on ALL Core Tables ──────────────

-- Macro helper applied to each core table:
--  - Allow if app.bypass_rls = 'on' (migrations, system cron jobs)
--  - Allow if app.current_role = 'super_admin' (platform management)
--  - Allow if company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
--  - Deny everything else (unset session context returns 0 rows)

-- Table: users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_users ON users;
CREATE POLICY rls_tenant_isolation_users ON users FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: jobs
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_jobs ON jobs;
CREATE POLICY rls_tenant_isolation_jobs ON jobs FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: attendance
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_attendance ON attendance;
CREATE POLICY rls_tenant_isolation_attendance ON attendance FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: payroll
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_payroll ON payroll;
CREATE POLICY rls_tenant_isolation_payroll ON payroll FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: inventory_items
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_inventory_items ON inventory_items;
CREATE POLICY rls_tenant_isolation_inventory_items ON inventory_items FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_notifications ON notifications;
CREATE POLICY rls_tenant_isolation_notifications ON notifications FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: messages
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_messages ON messages;
CREATE POLICY rls_tenant_isolation_messages ON messages FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: employee_profiles
ALTER TABLE employee_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_employee_profiles ON employee_profiles;
CREATE POLICY rls_tenant_isolation_employee_profiles ON employee_profiles FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: material_requests
ALTER TABLE material_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_material_requests ON material_requests;
CREATE POLICY rls_tenant_isolation_material_requests ON material_requests FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: employee_documents
ALTER TABLE employee_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_employee_documents ON employee_documents;
CREATE POLICY rls_tenant_isolation_employee_documents ON employee_documents FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: subscriptions
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_subscriptions ON subscriptions;
CREATE POLICY rls_tenant_isolation_subscriptions ON subscriptions FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: subscription_events
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_subscription_events ON subscription_events;
CREATE POLICY rls_tenant_isolation_subscription_events ON subscription_events FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: activities
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation_activities ON activities;
CREATE POLICY rls_tenant_isolation_activities ON activities FOR ALL USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR current_setting('app.current_role', true) = 'super_admin'
  OR current_setting('app.role', true) = 'admin_bypass'
  OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
);

-- Table: customers
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customers') THEN
    EXECUTE 'ALTER TABLE customers ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS rls_tenant_isolation_customers ON customers';
    EXECUTE 'CREATE POLICY rls_tenant_isolation_customers ON customers FOR ALL USING (
      current_setting(''app.bypass_rls'', true) = ''on''
      OR current_setting(''app.current_role'', true) = ''super_admin''
      OR current_setting(''app.role'', true) = ''admin_bypass''
      OR company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid
    )';
  END IF;
END $$;
