-- ===============================
-- SmartERP PostgreSQL Row-Level Security Policies
-- ⚠️  DO NOT run this automatically on startup
-- ⚠️  Test on staging first, then apply to production manually
-- ⚠️  Requires: app.current_company_id session variable set by db.js
-- ===============================
-- ROLLOUT PLAN:
-- Step 1: Run on staging, verify all queries work
-- Step 2: Run on production during low-traffic window
-- Step 3: Monitor error logs for 24h
-- Step 4: If issues, run the DISABLE section at the bottom
-- ===============================
-- IMPORTANT: Policies are FAIL-CLOSED.
-- If app.current_company_id is not set (missing context, raw connection,
-- admin script, etc.) the policy returns NO rows — not all rows.
-- Use app.role = 'admin_bypass' on a separate DB role for migrations/scripts.
-- ===============================

-- ── inventory_items ───────────────────────────────────────────────────────────
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;

-- Drop existing policy if re-running (idempotent)
DROP POLICY IF EXISTS inventory_company_isolation ON inventory_items;

CREATE POLICY inventory_company_isolation ON inventory_items
  USING (
    inventory_items.company_id::text = current_setting('app.current_company_id', true)
    OR current_setting('app.role', true) = 'admin_bypass'
  );

-- ── payroll ───────────────────────────────────────────────────────────────────
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_company_isolation ON payroll;

CREATE POLICY payroll_company_isolation ON payroll
  USING (
    payroll.company_id::text = current_setting('app.current_company_id', true)
    OR current_setting('app.role', true) = 'admin_bypass'
  );

-- ── users (employees) ─────────────────────────────────────────────────────────
-- ⚠️  INTENTIONALLY EXCLUDED FROM RLS ⚠️
-- Auth routes (login, signup, Google OAuth, password reset) query the users
-- table by email BEFORE a company context is known — no companyId is available
-- at that point, so fail-closed RLS would break all authentication.
-- Tenant isolation for users is enforced at the application layer in every
-- authenticated route via authenticateToken + company_id checks.
-- DO NOT add RLS to the users table without first redesigning auth to use a
-- separate, RLS-exempt DB role for credential lookups.

-- ── notifications ─────────────────────────────────────────────────────────────
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_company_isolation ON notifications;

CREATE POLICY notifications_company_isolation ON notifications
  USING (
    notifications.company_id::text = current_setting('app.current_company_id', true)
    OR current_setting('app.role', true) = 'admin_bypass'
  );

-- ── material_requests ─────────────────────────────────────────────────────────
ALTER TABLE material_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS material_requests_company_isolation ON material_requests;

CREATE POLICY material_requests_company_isolation ON material_requests
  USING (
    material_requests.company_id::text = current_setting('app.current_company_id', true)
    OR current_setting('app.role', true) = 'admin_bypass'
  );

-- ===============================
-- TO DISABLE (if issues arise — run these to instantly roll back):
-- ===============================
-- ALTER TABLE inventory_items DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE payroll DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE users DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE material_requests DISABLE ROW LEVEL SECURITY;
-- ===============================
-- TO DROP POLICIES (full cleanup):
-- ===============================
-- DROP POLICY IF EXISTS inventory_company_isolation ON inventory_items;
-- DROP POLICY IF EXISTS payroll_company_isolation ON payroll;
-- DROP POLICY IF EXISTS users_company_isolation ON users;
-- DROP POLICY IF EXISTS notifications_company_isolation ON notifications;
-- DROP POLICY IF EXISTS material_requests_company_isolation ON material_requests;
