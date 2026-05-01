-- ===============================
-- SmartERP Safe Schema Updates
-- Run on existing production databases
-- ALL statements use IF NOT EXISTS / IF EXISTS — safe to run multiple times
-- ===============================

-- ── users table ──────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_code VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- ── companies table (create if missing) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id VARCHAR(50) UNIQUE NOT NULL,
  company_name VARCHAR(255) NOT NULL,
  owner_id UUID,
  plan_id INTEGER DEFAULT 1,
  subscription_status VARCHAR(50) DEFAULT 'trial',
  is_on_trial BOOLEAN DEFAULT TRUE,
  trial_started_at TIMESTAMP DEFAULT NOW(),
  trial_ends_at TIMESTAMP,
  subscription_expires_at TIMESTAMP,
  is_first_login BOOLEAN DEFAULT TRUE,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ── plans table (create if missing) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  employee_limit INTEGER,
  max_inventory_items INTEGER,
  max_material_requests INTEGER,
  messages_history_days INTEGER,
  features JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- ── inventory_items — add missing columns ─────────────────────────────────────
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'Uncategorized';
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS unit VARCHAR(50) DEFAULT 'pieces';
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS min_quantity NUMERIC DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS employee_name VARCHAR(255);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier_contact VARCHAR(255);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier_email VARCHAR(255);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS deleted_by UUID;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS updated_by UUID;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS created_by UUID;

-- ── payroll table — add missing columns ──────────────────────────────────────
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS employee_name VARCHAR(255);
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS extra_amount NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS salary_increment NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS deduction NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS present_days INTEGER DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS absent_days INTEGER DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS half_days INTEGER DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS total_working_hours NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- ── employee_profiles — add company_id ───────────────────────────────────────
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS company_id UUID;

-- ── refresh_tokens — add security columns ────────────────────────────────────
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_family UUID;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked BOOLEAN DEFAULT FALSE;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip_address VARCHAR(100);

-- ── notifications — add company and type columns ──────────────────────────────
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type VARCHAR(100) DEFAULT 'system';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'normal';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB;

-- ── activities — add modern logging columns ───────────────────────────────────
ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_type TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS details JSONB;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

-- ── feedback — add admin reply columns ───────────────────────────────────────
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS admin_reply TEXT;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP;

-- ── New tables (create if missing) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token TEXT UNIQUE NOT NULL,
  device_type VARCHAR(50),
  last_seen TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_otps (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  otp_code VARCHAR(6) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID,
  document_type VARCHAR(100),
  document_name VARCHAR(255),
  file_url TEXT,
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_inventory_company_id ON inventory_items(company_id);
CREATE INDEX IF NOT EXISTS idx_payroll_company_id ON payroll(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps(email);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);

-- ── Fix stuck customer jobs: completed/accepted jobs still showing pending_approval ──
-- Jobs that were accepted by an employee (approval_status still pending_approval)
-- should be marked as approved since the employee clearly worked on them.
UPDATE jobs
SET approval_status = 'approved',
    approved_at     = COALESCE(accepted_at, started_at, NOW())
WHERE source = 'customer'
  AND approval_status = 'pending_approval'
  AND (
    status IN ('completed', 'in_progress', 'active')
    OR employee_status IN ('accepted', 'completed', 'arrived')
  );
