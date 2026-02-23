-- Simple Multi-Tenant Migration
-- Run this in your PostgreSQL database

-- 1. Create Companies table
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  company_id VARCHAR(20) UNIQUE NOT NULL,
  company_name VARCHAR(255) NOT NULL,
  owner_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. Add company columns to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_code VARCHAR(20);

-- 3. Create default company
INSERT INTO companies (company_id, company_name) VALUES ('SMR1001', 'Default Company') ON CONFLICT (company_id) DO NOTHING;

-- 4. Link owner and employees
UPDATE companies SET owner_id = (SELECT id FROM users WHERE email = 'thepreethu01@gmail.com') WHERE company_id = 'SMR1001';
UPDATE users SET company_id = (SELECT id FROM companies WHERE company_id = 'SMR1001'), company_code = 'SMR1001' WHERE email = 'thepreethu01@gmail.com';
UPDATE users SET company_id = (SELECT id FROM companies WHERE company_id = 'SMR1001'), company_code = 'SMR1001' WHERE company_id IS NULL AND role != 'owner';

-- 5. Add company_id to business tables
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE payroll_entries ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

-- 6. Backfill company_id
UPDATE jobs SET company_id = (SELECT id FROM companies WHERE company_id = 'SMR1001') WHERE company_id IS NULL;
UPDATE inventory_items SET company_id = (SELECT id FROM companies WHERE company_id = 'SMR1001') WHERE company_id IS NULL;
UPDATE material_requests SET company_id = (SELECT id FROM companies WHERE company_id = 'SMR1001') WHERE company_id IS NULL;
UPDATE notifications SET company_id = (SELECT id FROM companies WHERE company_id = 'SMR1001') WHERE company_id IS NULL;
UPDATE payroll_runs SET company_id = (SELECT id FROM companies WHERE company_id = 'SMR1001') WHERE company_id IS NULL;
UPDATE payroll_entries SET company_id = (SELECT id FROM companies WHERE company_id = 'SMR1001') WHERE company_id IS NULL;
UPDATE employee_profiles SET company_id = (SELECT id FROM companies WHERE company_id = 'SMR1001') WHERE company_id IS NULL;
UPDATE activities SET company_id = (SELECT id FROM companies WHERE company_id = 'SMR1001') WHERE company_id IS NULL;

-- 7. Create indexes
CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_company_code ON users(company_code);
CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_inventory_company_id ON inventory_items(company_id);
CREATE INDEX IF NOT EXISTS idx_material_requests_company_id ON material_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);

-- 8. Create sequence
CREATE SEQUENCE IF NOT EXISTS company_id_seq START WITH 1002;

-- Verification
SELECT 'Companies created:' as info, COUNT(*) as count FROM companies
UNION ALL
SELECT 'Users linked:' as info, COUNT(*) as count FROM users WHERE company_id IS NOT NULL
UNION ALL
SELECT 'Jobs linked:' as info, COUNT(*) as count FROM jobs WHERE company_id IS NOT NULL;
