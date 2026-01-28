-- ===============================
-- Multi-Tenant Migration Script
-- Adds company isolation to SmartERP
-- ===============================

BEGIN;

-- 1. Create companies table
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  owner_email VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  industry VARCHAR(100),
  size VARCHAR(50),
  is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_companies_owner_email ON companies(owner_email);

-- 2. Add company_id to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS position VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);

-- 3. Add company_id to jobs
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id);

-- 4. Add company_id to attendance_records
-- 4. Add company_id to attendance
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_attendance_company_id ON attendance(company_id);


-- 5. Add company_id to inventory_items
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_inventory_company_id ON inventory(company_id);


-- 6. Add company_id to material_requests
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_material_requests_company_id ON material_requests(company_id);

-- 7. Add company_id to payroll_runs
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_payroll_company_id ON payroll(company_id);


-- 8. Add company_id to notifications


-- 10. Add company_id to activities
ALTER TABLE activities ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_activities_company_id ON activities(company_id);

COMMIT;
