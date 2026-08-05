-- 021_cnc_phase2.sql
-- SmartERP CNC Service Edition — Phase 2 Database Extensions

-- 1. SLA Monitoring & Metrics
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_target_hours NUMERIC DEFAULT 4.0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_response_minutes INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_resolution_minutes INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_status VARCHAR(50) DEFAULT 'on_track'; -- 'on_track', 'warning', 'breached'
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_breach_reason TEXT;

-- 2. Customer Feedback & NPS Analytics
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS technical_rating INTEGER CHECK (technical_rating BETWEEN 1 AND 5);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS communication_rating INTEGER CHECK (communication_rating BETWEEN 1 AND 5);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS professionalism_rating INTEGER CHECK (professionalism_rating BETWEEN 1 AND 5);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS nps_score INTEGER CHECK (nps_score BETWEEN 0 AND 10);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS feedback_notes TEXT;

-- 3. Supplier Warranty Claims Tracking
CREATE TABLE IF NOT EXISTS warranty_claims (
  id SERIAL PRIMARY KEY,
  company_id TEXT NOT NULL,
  claim_number VARCHAR(100) UNIQUE NOT NULL,
  machine_id INTEGER REFERENCES customer_machines(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  spare_part_name VARCHAR(255) NOT NULL,
  serial_number VARCHAR(255),
  supplier_name VARCHAR(255) NOT NULL,
  failure_reason TEXT,
  status VARCHAR(50) DEFAULT 'submitted', -- 'submitted', 'under_review', 'approved', 'rejected', 'replaced'
  supplier_credit_amount NUMERIC(12, 2) DEFAULT 0,
  replacement_inventory_id INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_warranty_claims_company ON warranty_claims(company_id);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_machine ON warranty_claims(machine_id);

-- 4. Customer Self-Service Documents Category Tags & Expiry Alerts
ALTER TABLE customer_machine_documents ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'general';
ALTER TABLE customer_machine_documents ADD COLUMN IF NOT EXISTS is_customer_visible BOOLEAN DEFAULT true;
ALTER TABLE customer_machine_documents ADD COLUMN IF NOT EXISTS expiry_date DATE;
