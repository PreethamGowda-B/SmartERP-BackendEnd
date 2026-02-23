-- ===============================
-- Multi-Tenant Architecture Migration
-- Adds Companies table and company_id to all tables
-- Links existing data to thepreethu01@gmail.com
-- ===============================

-- Step 1: Create Companies table
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  company_id VARCHAR(20) UNIQUE NOT NULL,  -- Format: SMR1001, SMR1002, etc.
  company_name VARCHAR(255) NOT NULL,
  owner_id INTEGER,  -- Will be set after users table is updated
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Step 2: Add company_id columns to users table
ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id),
  ADD COLUMN IF NOT EXISTS company_code VARCHAR(20);

-- Step 3: Create default company for existing data
INSERT INTO companies (company_id, company_name, created_at)
VALUES ('SMR1001', 'Default Company', NOW())
ON CONFLICT (company_id) DO NOTHING;

-- Step 4: Get the default company ID and link users
DO $$
DECLARE
  default_company_id INTEGER;
  owner_user_id INTEGER;
BEGIN
  -- Get default company ID
  SELECT id INTO default_company_id FROM companies WHERE company_id = 'SMR1001';
  
  -- Get owner user ID (thepreethu01@gmail.com)
  SELECT id INTO owner_user_id FROM users WHERE email = 'thepreethu01@gmail.com';
  
  -- Update default company with owner_id
  IF owner_user_id IS NOT NULL THEN
    UPDATE companies 
    SET owner_id = owner_user_id 
    WHERE company_id = 'SMR1001';
    
    -- Link owner to company
    UPDATE users 
    SET company_id = default_company_id,
        company_code = 'SMR1001'
    WHERE email = 'thepreethu01@gmail.com';
    
    RAISE NOTICE 'Linked owner thepreethu01@gmail.com to company SMR1001';
  ELSE
    RAISE NOTICE 'Owner email thepreethu01@gmail.com not found. Please create owner account first.';
  END IF;
  
  -- Link all existing employees to default company
  UPDATE users 
  SET company_id = default_company_id,
      company_code = 'SMR1001'
  WHERE company_id IS NULL 
    AND role != 'owner';
  
  RAISE NOTICE 'Linked all existing employees to company SMR1001';
END $$;

-- Step 5: Add company_id to business tables

-- Jobs table
ALTER TABLE jobs 
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

-- Attendance table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'attendance') THEN
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
  END IF;
END $$;

-- Attendance records table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'attendance_records') THEN
    ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
  END IF;
END $$;

-- Inventory items table
ALTER TABLE inventory_items 
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

-- Material requests table
ALTER TABLE material_requests 
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

-- Material request items table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'material_request_items') THEN
    ALTER TABLE material_request_items ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
  END IF;
END $$;

-- Notifications table
ALTER TABLE notifications 
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

-- Messages table (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'messages') THEN
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
  END IF;
END $$;

-- Payroll runs table
ALTER TABLE payroll_runs 
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

-- Payroll entries table
ALTER TABLE payroll_entries 
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

-- Employee profiles table
ALTER TABLE employee_profiles 
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

-- Activities table
ALTER TABLE activities 
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

-- Step 6: Backfill company_id for all existing data
DO $$
DECLARE
  default_company_id INTEGER;
BEGIN
  -- Get default company ID
  SELECT id INTO default_company_id FROM companies WHERE company_id = 'SMR1001';
  
  -- Update all business tables with default company_id
  UPDATE jobs SET company_id = default_company_id WHERE company_id IS NULL;
  
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'attendance') THEN
    EXECUTE 'UPDATE attendance SET company_id = $1 WHERE company_id IS NULL' USING default_company_id;
  END IF;
  
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'attendance_records') THEN
    EXECUTE 'UPDATE attendance_records SET company_id = $1 WHERE company_id IS NULL' USING default_company_id;
  END IF;
  
  UPDATE inventory_items SET company_id = default_company_id WHERE company_id IS NULL;
  UPDATE material_requests SET company_id = default_company_id WHERE company_id IS NULL;
  UPDATE notifications SET company_id = default_company_id WHERE company_id IS NULL;
  UPDATE payroll_runs SET company_id = default_company_id WHERE company_id IS NULL;
  UPDATE employee_profiles SET company_id = default_company_id WHERE company_id IS NULL;
  UPDATE activities SET company_id = default_company_id WHERE company_id IS NULL;
  
  -- Update messages table if it exists
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'messages') THEN
    EXECUTE 'UPDATE messages SET company_id = $1 WHERE company_id IS NULL' USING default_company_id;
  END IF;
  
  RAISE NOTICE 'Backfilled company_id for all existing data';
END $$;

-- Step 7: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_company_code ON users(company_code);
CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_inventory_company_id ON inventory_items(company_id);
CREATE INDEX IF NOT EXISTS idx_material_requests_company_id ON material_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_company_id ON payroll_runs(company_id);
CREATE INDEX IF NOT EXISTS idx_employee_profiles_company_id ON employee_profiles(company_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'attendance') THEN
    CREATE INDEX IF NOT EXISTS idx_attendance_company_id ON attendance(company_id);
  END IF;
END $$;

-- Step 8: Create sequence for auto-incrementing company IDs
CREATE SEQUENCE IF NOT EXISTS company_id_seq START WITH 1002;

-- Step 9: Verify migration
DO $$
DECLARE
  company_count INTEGER;
  users_with_company INTEGER;
  jobs_with_company INTEGER;
BEGIN
  SELECT COUNT(*) INTO company_count FROM companies;
  SELECT COUNT(*) INTO users_with_company FROM users WHERE company_id IS NOT NULL;
  SELECT COUNT(*) INTO jobs_with_company FROM jobs WHERE company_id IS NOT NULL;
  
  RAISE NOTICE '=== Migration Summary ===';
  RAISE NOTICE 'Companies created: %', company_count;
  RAISE NOTICE 'Users linked to companies: %', users_with_company;
  RAISE NOTICE 'Jobs linked to companies: %', jobs_with_company;
  RAISE NOTICE '========================';
END $$;
