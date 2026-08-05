-- 023_cnc_master_release.sql
-- SmartERP CNC Service Edition — Master Release Extensions (Phases 4, 5 & 6)

-- 1. Vendors Table
CREATE TABLE IF NOT EXISTS cnc_vendors (
  id SERIAL PRIMARY KEY,
  company_id TEXT NOT NULL,
  vendor_name VARCHAR(255) NOT NULL,
  contact_person VARCHAR(255),
  phone VARCHAR(50),
  email VARCHAR(255),
  rating NUMERIC(3, 2) DEFAULT 4.8,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cnc_vendors_company ON cnc_vendors(company_id);

-- 2. Spare Part Purchase Orders Table
CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  company_id TEXT NOT NULL,
  po_number VARCHAR(100) UNIQUE NOT NULL,
  vendor_name VARCHAR(255) NOT NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  parts_description TEXT NOT NULL,
  total_cost NUMERIC(12, 2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'issued', -- 'issued', 'approved', 'received', 'cancelled'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_company ON purchase_orders(company_id);

-- 3. Technician Route Optimizations Table
CREATE TABLE IF NOT EXISTS engineer_routes (
  id SERIAL PRIMARY KEY,
  company_id TEXT NOT NULL,
  engineer_id UUID NOT NULL,
  engineer_name VARCHAR(255) NOT NULL,
  route_date DATE DEFAULT CURRENT_DATE,
  stops_count INTEGER DEFAULT 1,
  total_km NUMERIC(8, 2) DEFAULT 15.0,
  optimized_minutes INTEGER DEFAULT 45,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_engineer_routes_company ON engineer_routes(company_id);

-- 4. SaaS Subscriptions & Billing Log
CREATE TABLE IF NOT EXISTS saas_subscriptions (
  id SERIAL PRIMARY KEY,
  company_id TEXT NOT NULL UNIQUE,
  plan_tier VARCHAR(50) DEFAULT 'pro', -- 'free', 'basic', 'pro'
  razorpay_subscription_id VARCHAR(100),
  billing_cycle VARCHAR(50) DEFAULT 'monthly',
  status VARCHAR(50) DEFAULT 'active',
  current_period_end TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '30 days'),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
