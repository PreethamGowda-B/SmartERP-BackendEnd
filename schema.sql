-- ===============================
-- SmartERP Database Schema
-- Base schema for fresh deployments
-- ===============================
-- ⚠️  NOTE: This file creates the base structure.
-- Run migrations/schema_updates.sql after this to add all production columns.
-- ===============================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  role VARCHAR(50) NOT NULL DEFAULT 'employee',
  phone VARCHAR(50),
  position VARCHAR(100),
  department VARCHAR(100),
  company_id UUID,
  company_code VARCHAR(50),
  google_id VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Companies table
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

-- Plans table
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

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES plans(id),
  start_date TIMESTAMP DEFAULT NOW(),
  end_date TIMESTAMP,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Subscription events
CREATE TABLE IF NOT EXISTS subscription_events (
  id SERIAL PRIMARY KEY,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  event_type VARCHAR(100),
  old_plan_id INTEGER,
  new_plan_id INTEGER,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Activities table
CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  action VARCHAR(255) NOT NULL,
  activity_type TEXT,
  details JSONB,
  ip_address VARCHAR(50),
  user_agent VARCHAR(255),
  company_id UUID,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  assigned_to UUID REFERENCES users(id),
  created_by UUID REFERENCES users(id),
  company_id UUID REFERENCES companies(id),
  status VARCHAR(50) DEFAULT 'open',
  priority VARCHAR(50) DEFAULT 'medium',
  data JSONB,
  visible_to_all BOOLEAN DEFAULT false,
  employee_status VARCHAR(50) DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  accepted_at TIMESTAMP,
  declined_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT jobs_status_check CHECK (status IN ('open', 'pending', 'in_progress', 'active', 'completed', 'closed', 'cancelled'))
);

-- Employee profile details
CREATE TABLE IF NOT EXISTS employee_profiles (
  id SERIAL PRIMARY KEY,
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  phone VARCHAR(50),
  position VARCHAR(100),
  department VARCHAR(100),
  hire_date DATE,
  is_active BOOLEAN DEFAULT TRUE,
  company_id UUID REFERENCES companies(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Attendance table (production name is 'attendance', not 'attendance_records')
CREATE TABLE IF NOT EXISTS attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  company_id UUID REFERENCES companies(id),
  date DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'present',
  clock_in TIMESTAMP,
  clock_out TIMESTAMP,
  working_hours NUMERIC DEFAULT 0,
  location VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Inventory items
CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  quantity NUMERIC DEFAULT 0,
  unit VARCHAR(50) DEFAULT 'pieces',
  category VARCHAR(100) DEFAULT 'Uncategorized',
  min_quantity NUMERIC DEFAULT 0,
  image_url TEXT,
  employee_name VARCHAR(255),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  company_id UUID REFERENCES companies(id),
  supplier_name VARCHAR(255),
  supplier_contact VARCHAR(255),
  supplier_email VARCHAR(255),
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMP,
  deleted_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Material requests
CREATE TABLE IF NOT EXISTS material_requests (
  id SERIAL PRIMARY KEY,
  item_name VARCHAR(255) NOT NULL,
  quantity NUMERIC NOT NULL,
  unit VARCHAR(50),
  urgency VARCHAR(50) DEFAULT 'normal',
  description TEXT,
  notes TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  requested_by UUID REFERENCES users(id),
  requested_by_name VARCHAR(255),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMP,
  company_id UUID REFERENCES companies(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Payroll table (production uses 'payroll', not 'payroll_runs')
CREATE TABLE IF NOT EXISTS payroll (
  id SERIAL PRIMARY KEY,
  employee_email VARCHAR(255),
  employee_id UUID REFERENCES users(id),
  employee_name VARCHAR(255),
  payroll_month INTEGER NOT NULL,
  payroll_year INTEGER NOT NULL,
  base_salary NUMERIC NOT NULL,
  extra_amount NUMERIC DEFAULT 0,
  salary_increment NUMERIC DEFAULT 0,
  deduction NUMERIC DEFAULT 0,
  total_salary NUMERIC NOT NULL,
  present_days INTEGER DEFAULT 0,
  absent_days INTEGER DEFAULT 0,
  half_days INTEGER DEFAULT 0,
  total_working_hours NUMERIC DEFAULT 0,
  remarks TEXT,
  created_by UUID REFERENCES users(id),
  company_id UUID REFERENCES companies(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  company_id UUID REFERENCES companies(id),
  type VARCHAR(100) DEFAULT 'system',
  title VARCHAR(255),
  message TEXT,
  priority VARCHAR(50) DEFAULT 'normal',
  read BOOLEAN DEFAULT FALSE,
  data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  token_family UUID,
  revoked BOOLEAN DEFAULT FALSE,
  user_agent TEXT,
  ip_address VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

-- User devices (FCM push tokens)
CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token TEXT UNIQUE NOT NULL,
  device_type VARCHAR(50),
  last_seen TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Email OTPs
CREATE TABLE IF NOT EXISTS email_otps (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  otp_code VARCHAR(6) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Feedback
CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  type VARCHAR(50) DEFAULT 'general',
  subject VARCHAR(255),
  message TEXT NOT NULL,
  page_url TEXT,
  status VARCHAR(50) DEFAULT 'new',
  admin_reply TEXT,
  replied_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID REFERENCES users(id),
  receiver_id UUID REFERENCES users(id),
  company_id UUID REFERENCES companies(id),
  content TEXT NOT NULL,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Employee documents
CREATE TABLE IF NOT EXISTS employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id),
  document_type VARCHAR(100),
  document_name VARCHAR(255),
  file_url TEXT,
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ===============================
-- Indexes for performance
-- ===============================
CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_attendance_user_id ON attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_company_id ON attendance(company_id);
CREATE INDEX IF NOT EXISTS idx_inventory_company_id ON inventory_items(company_id);
CREATE INDEX IF NOT EXISTS idx_payroll_company_id ON payroll(company_id);
CREATE INDEX IF NOT EXISTS idx_payroll_employee_id ON payroll(employee_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps(email);
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);
