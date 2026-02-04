-- ===============================
-- SmartERP Database Schema
-- Fully Updated with Inventory Images
-- ===============================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'user',
  phone VARCHAR(50),
  position VARCHAR(100),
  department VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Activities table (with IP and user-agent)
CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(255) NOT NULL,
  ip_address VARCHAR(50),
  user_agent VARCHAR(255),
  timestamp TIMESTAMP DEFAULT NOW()
);

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  assigned_to INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  status VARCHAR(50) DEFAULT 'open',
  priority VARCHAR(50) DEFAULT 'medium',
  data JSONB,
  visible_to_all BOOLEAN DEFAULT false,
  employee_status VARCHAR(50) DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  accepted_at TIMESTAMP,
  declined_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Employee profile details (linked to users)
CREATE TABLE IF NOT EXISTS employee_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  phone VARCHAR(50),
  position VARCHAR(100),
  department VARCHAR(100),
  hire_date DATE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Attendance records
CREATE TABLE IF NOT EXISTS attendance_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  job_id INTEGER REFERENCES jobs(id),
  clock_in TIMESTAMP,
  clock_out TIMESTAMP,
  duration_seconds INTEGER,
  status VARCHAR(50) DEFAULT 'recorded',
  location VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Inventory and material requests
CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(100),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  quantity NUMERIC DEFAULT 0,
  unit VARCHAR(50),
  location VARCHAR(255),
  reorder_threshold NUMERIC DEFAULT 0,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS material_requests (
  id SERIAL PRIMARY KEY,
  request_number VARCHAR(50) UNIQUE,
  requested_by INTEGER REFERENCES users(id),
  status VARCHAR(50) DEFAULT 'pending',
  approved_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS material_request_items (
  id SERIAL PRIMARY KEY,
  request_id INTEGER REFERENCES material_requests(id) ON DELETE CASCADE,
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  name VARCHAR(255),
  quantity NUMERIC NOT NULL,
  unit VARCHAR(50),
  status VARCHAR(50) DEFAULT 'requested'
);

-- Payroll
CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payroll_entries (
  id SERIAL PRIMARY KEY,
  payroll_run_id INTEGER REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  gross_amount NUMERIC NOT NULL,
  deductions NUMERIC DEFAULT 0,
  net_amount NUMERIC NOT NULL,
  status VARCHAR(50) DEFAULT 'unpaid'
);

CREATE TABLE IF NOT EXISTS payroll_payments (
  id SERIAL PRIMARY KEY,
  payroll_entry_id INTEGER REFERENCES payroll_entries(id) ON DELETE CASCADE,
  paid_at TIMESTAMP,
  method VARCHAR(50),
  reference VARCHAR(255)
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title VARCHAR(255),
  message TEXT,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Refresh tokens for cookie-based sessions
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

-- ===============================
-- Insert a test admin user
-- Password: TestPassword123
-- Use bcrypt hash
-- ===============================
INSERT INTO users (email, password_hash, role)
VALUES (
  'admin@example.com',
  '$2b$10$4GmZgZ6OaV.RwIPqA7q59OcGH.CqK0k/Esni7Uq0l8svXzv.0Em1G',
  'admin'
)
ON CONFLICT (email) DO NOTHING;

-- Add image_url column to existing inventory_items table if it doesn't exist
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_url TEXT;