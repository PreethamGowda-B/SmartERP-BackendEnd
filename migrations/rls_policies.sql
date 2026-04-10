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
-- Step 4: If issues, run the DISABLE section below
-- ===============================

-- ── inventory_items ───────────────────────────────────────────────────────────
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;

-- Allow full access when company context matches
CREATE POLICY inventory_company_isolation ON inventory_items
  USING (
    company_id::text = current_setting('app.current_company_id', true)
    OR current_setting('app.current_company_id', true) IS NULL
    OR current_setting('app.current_company_id', true) = ''
  );

-- ── payroll ───────────────────────────────────────────────────────────────────
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_company_isolation ON payroll
  USING (
    company_id::text = current_setting('app.current_company_id', true)
    OR current_setting('app.current_company_id', true) IS NULL
    OR current_setting('app.current_company_id', true) = ''
  );

-- ── users (employees) ─────────────────────────────────────────────────────────
-- Note: Be careful with this one — auth queries run without company context
-- The NULL/empty check ensures auth routes still work
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_company_isolation ON users
  USING (
    company_id::text = current_setting('app.current_company_id', true)
    OR current_setting('app.current_company_id', true) IS NULL
    OR current_setting('app.current_company_id', true) = ''
  );

-- ── notifications ─────────────────────────────────────────────────────────────
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_company_isolation ON notifications
  USING (
    company_id::text = current_setting('app.current_company_id', true)
    OR current_setting('app.current_company_id', true) IS NULL
    OR current_setting('app.current_company_id', true) = ''
  );

-- ── material_requests ─────────────────────────────────────────────────────────
ALTER TABLE material_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY material_requests_company_isolation ON material_requests
  USING (
    company_id::text = current_setting('app.current_company_id', true)
    OR current_setting('app.current_company_id', true) IS NULL
    OR current_setting('app.current_company_id', true) = ''
  );

-- ===============================
-- TO DISABLE (if issues arise):
-- ===============================
-- ALTER TABLE inventory_items DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE payroll DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE users DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE material_requests DISABLE ROW LEVEL SECURITY;
-- ===============================
-- TO DROP POLICIES (if needed):
-- ===============================
-- DROP POLICY IF EXISTS inventory_company_isolation ON inventory_items;
-- DROP POLICY IF EXISTS payroll_company_isolation ON payroll;
-- DROP POLICY IF EXISTS users_company_isolation ON users;
-- DROP POLICY IF EXISTS notifications_company_isolation ON notifications;
-- DROP POLICY IF EXISTS material_requests_company_isolation ON material_requests;
