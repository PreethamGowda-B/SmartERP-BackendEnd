-- ─── 020_CNC_SERVICE_EDITION.SQL ──────────────────────────────────────────────
-- SmartERP CNC Service Edition Phase 1 Database Migration
-- Supports multi-tenant company_id isolation across all tables.

-- 1. Factory Plants & Lines Hierarchy
CREATE TABLE IF NOT EXISTS customer_plants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  plant_name VARCHAR(255) NOT NULL,
  code VARCHAR(50),
  address TEXT,
  contact_person VARCHAR(255),
  contact_phone VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_plants_company ON customer_plants(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_plants_customer ON customer_plants(customer_id);

-- 2. Customer Machine Registry
CREATE TABLE IF NOT EXISTS customer_machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  plant_id TEXT,
  production_line VARCHAR(100),
  area_location VARCHAR(100),
  machine_name VARCHAR(255) NOT NULL,
  make VARCHAR(100) NOT NULL,               -- Haas, Mazak, DMG Mori, Jyoti, Ace Micromatic
  model VARCHAR(100) NOT NULL,              -- VF-2, VMC 850, DX 200
  serial_number VARCHAR(100) NOT NULL,
  controller_type VARCHAR(100) NOT NULL,    -- Fanuc 0i-MF, Siemens 828D, Mitsubishi M80, Heidenhain
  year_of_manufacture INT,
  spindle_hours INT DEFAULT 0,
  installation_date DATE,
  warranty_start_date DATE,
  warranty_end_date DATE,
  health_score INT DEFAULT 100,
  status VARCHAR(50) DEFAULT 'operational', -- 'operational', 'breakdown', 'maintenance', 'decommissioned'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_machines_company ON customer_machines(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_machines_customer ON customer_machines(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_machines_serial ON customer_machines(serial_number);

-- 3. Machine Sub-Components
CREATE TABLE IF NOT EXISTS machine_subcomponents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  component_type VARCHAR(50) NOT NULL, -- 'servo_drive', 'spindle_motor', 'tool_magazine', 'hydraulic_unit', 'coolant_system', 'electrical_cabinet'
  name VARCHAR(255) NOT NULL,
  make_model VARCHAR(255),
  serial_number VARCHAR(100),
  specs JSONB DEFAULT '{}'::jsonb,
  installed_at DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_machine_subcomponents_machine ON machine_subcomponents(machine_id);

-- 4. AMC Contracts Table
CREATE TABLE IF NOT EXISTS amc_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  contract_number VARCHAR(100) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  contract_type VARCHAR(50) DEFAULT 'comprehensive', -- 'comprehensive', 'non_comprehensive', 'labor_only'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  total_value NUMERIC(12,2) DEFAULT 0.00,
  preventive_visits_total INT DEFAULT 4,
  preventive_visits_done INT DEFAULT 0,
  breakdown_visits_included INT DEFAULT 12,
  breakdown_visits_done INT DEFAULT 0,
  status VARCHAR(50) DEFAULT 'active', -- 'draft', 'active', 'expired', 'cancelled'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_amc_contracts_company ON amc_contracts(company_id);
CREATE INDEX IF NOT EXISTS idx_amc_contracts_customer ON amc_contracts(customer_id);

-- 5. Service Quotations & Estimates
CREATE TABLE IF NOT EXISTS service_quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  quotation_number VARCHAR(100) NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  machine_id TEXT,
  title VARCHAR(255) NOT NULL,
  labor_amount NUMERIC(10,2) DEFAULT 0.00,
  spares_amount NUMERIC(10,2) DEFAULT 0.00,
  travel_amount NUMERIC(10,2) DEFAULT 0.00,
  total_amount NUMERIC(10,2) DEFAULT 0.00,
  status VARCHAR(50) DEFAULT 'draft', -- 'draft', 'sent', 'approved', 'rejected', 'converted_to_job'
  job_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_quotations_company ON service_quotations(company_id);

-- 6. Remote Support Sessions
CREATE TABLE IF NOT EXISTS remote_support_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  machine_id TEXT,
  engineer_id TEXT NOT NULL,
  support_channel VARCHAR(50) NOT NULL, -- 'phone', 'whatsapp', 'anydesk', 'teamviewer', 'fanuc_focas', 'siemens_remote'
  duration_minutes INT DEFAULT 0,
  resolution_summary TEXT,
  status VARCHAR(50) DEFAULT 'resolved', -- 'resolved', 'unresolved_converted_to_job'
  job_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remote_support_company ON remote_support_sessions(company_id);

-- 7. Service Costing & Job Profitability
CREATE TABLE IF NOT EXISTS job_costing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  machine_id TEXT,
  labor_cost NUMERIC(10,2) DEFAULT 0.00,
  travel_cost NUMERIC(10,2) DEFAULT 0.00,
  spares_cost NUMERIC(10,2) DEFAULT 0.00,
  expenses_cost NUMERIC(10,2) DEFAULT 0.00,
  total_cost NUMERIC(10,2) DEFAULT 0.00,
  invoice_amount NUMERIC(10,2) DEFAULT 0.00,
  net_profit NUMERIC(10,2) DEFAULT 0.00,
  profit_margin_percent NUMERIC(5,2) DEFAULT 0.00,
  sla_status VARCHAR(50) DEFAULT 'met',
  response_time_minutes INT,
  resolution_time_minutes INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Warranty Claims
CREATE TABLE IF NOT EXISTS warranty_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  job_id TEXT,
  part_name VARCHAR(255) NOT NULL,
  serial_number VARCHAR(100),
  claim_type VARCHAR(50) DEFAULT 'spare_part',
  vendor_name VARCHAR(255),
  status VARCHAR(50) DEFAULT 'submitted',
  claim_amount NUMERIC(10,2) DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. Customer Machine Documents
CREATE TABLE IF NOT EXISTS customer_machine_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  document_type VARCHAR(50) NOT NULL, -- 'user_manual', 'electrical_schema', 'plc_backup', 'parameter_file', 'warranty_doc'
  title VARCHAR(255) NOT NULL,
  file_url TEXT NOT NULL,
  file_size INT,
  uploaded_by_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 10. Machine Timeline Events
CREATE TABLE IF NOT EXISTS machine_timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  job_id TEXT,
  invoice_id TEXT,
  event_type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 11. CNC Alarm Code Knowledge Base
CREATE TABLE IF NOT EXISTS cnc_alarm_kb (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  controller_type VARCHAR(100) NOT NULL,
  alarm_code VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  cause_description TEXT,
  recommended_fix TEXT,
  occurrences_count INT DEFAULT 1,
  solved_count INT DEFAULT 1,
  avg_repair_hours NUMERIC(4,2) DEFAULT 1.5,
  common_spares JSONB DEFAULT '[]'::jsonb,
  required_tools JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 12. Service Checklist Templates
CREATE TABLE IF NOT EXISTS service_checklist_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  service_type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 13. Extend `jobs` Table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS machine_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS controller_type VARCHAR(100);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS alarm_code VARCHAR(100);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS service_type VARCHAR(50) DEFAULT 'breakdown';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS amc_contract_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS service_checklist JSONB DEFAULT '[]'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS travel_timestamps JSONB DEFAULT '{}'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS toolkit_checklist JSONB DEFAULT '[]'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS site_expenses JSONB DEFAULT '[]'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assigned_team JSONB DEFAULT '[]'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reserved_spares JSONB DEFAULT '[]'::jsonb;

-- 14. Extend `inventory` Table
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS part_number VARCHAR(100);
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'general';
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS machine_compatibility JSONB DEFAULT '[]'::jsonb;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS is_consumable BOOLEAN DEFAULT FALSE;

-- 15. Extend `employee_profiles` Table
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS cnc_skills JSONB DEFAULT '{"fanuc":5,"siemens":4,"mitsubishi":4,"plc":5,"servo":4}'::jsonb;
