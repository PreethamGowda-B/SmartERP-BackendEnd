-- ====================================================================
-- SmartERP Migration 015: Job-Centric Finance & Invoicing System
-- ====================================================================

-- 1. Create Enums if not exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status_enum') THEN
        CREATE TYPE invoice_status_enum AS ENUM (
          'draft', 'issued', 'sent', 'viewed', 'disputed', 'partially_paid', 'paid', 'cancelled'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dispute_status_enum') THEN
        CREATE TYPE dispute_status_enum AS ENUM (
          'open', 'under_review', 'resolved', 'rejected'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_action_enum') THEN
        CREATE TYPE invoice_action_enum AS ENUM (
          'viewed', 'downloaded', 'shared_whatsapp', 'shared_email'
        );
    END IF;
END $$;

-- 2. Alter Jobs Table (Add billability and review fields)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_billable BOOLEAN DEFAULT TRUE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS billing_type VARCHAR(50) DEFAULT 'hourly';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS review_notes TEXT;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;

-- 3. Invoices Table (Supports versioning and complete financial breakdown)
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id),
  customer_name VARCHAR(255),
  customer_email VARCHAR(255),
  customer_phone VARCHAR(50),
  invoice_number VARCHAR(100) NOT NULL,
  version_number INT DEFAULT 1,
  edited_count INT DEFAULT 0,
  parent_invoice_id UUID REFERENCES invoices(id),
  is_latest BOOLEAN DEFAULT TRUE,
  status VARCHAR(50) DEFAULT 'draft',
  
  -- Breakdown Fields
  labour_hours NUMERIC(10,2) DEFAULT 0.00,
  labour_rate NUMERIC(10,2) DEFAULT 0.00,
  labour_cost NUMERIC(15,2) DEFAULT 0.00,
  materials_cost NUMERIC(15,2) DEFAULT 0.00,
  equipment_charges NUMERIC(15,2) DEFAULT 0.00,
  transport_charges NUMERIC(15,2) DEFAULT 0.00,
  additional_charges NUMERIC(15,2) DEFAULT 0.00,
  discount_amount NUMERIC(15,2) DEFAULT 0.00,
  subtotal NUMERIC(15,2) DEFAULT 0.00,
  
  -- GST Breakdown
  is_inter_state BOOLEAN DEFAULT FALSE,
  gst_rate NUMERIC(5,2) DEFAULT 18.00,
  cgst NUMERIC(15,2) DEFAULT 0.00,
  sgst NUMERIC(15,2) DEFAULT 0.00,
  igst NUMERIC(15,2) DEFAULT 0.00,
  total_tax NUMERIC(15,2) DEFAULT 0.00,
  
  -- Totals
  total_amount NUMERIC(15,2) DEFAULT 0.00,
  amount_paid NUMERIC(15,2) DEFAULT 0.00,
  amount_due NUMERIC(15,2) DEFAULT 0.00,
  
  due_date DATE,
  payment_terms TEXT DEFAULT 'Due on receipt',
  customer_notes TEXT,
  internal_notes TEXT,
  pdf_url TEXT,
  
  viewed_at TIMESTAMP WITH TIME ZONE,
  downloaded_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  CONSTRAINT unq_company_invoice_version UNIQUE (company_id, invoice_number, version_number)
);

-- Ensure all columns exist on legacy invoices table
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS version_number INT DEFAULT 1;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS parent_invoice_id UUID REFERENCES invoices(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_latest BOOLEAN DEFAULT TRUE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS labour_hours NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS labour_rate NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS labour_cost NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS materials_cost NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS equipment_charges NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS transport_charges NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS additional_charges NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_inter_state BOOLEAN DEFAULT FALSE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2) DEFAULT 18.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cgst NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sgst NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS igst NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total_tax NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total_amount NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_due NUMERIC(15,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_terms TEXT DEFAULT 'Due on receipt';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_notes TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS internal_notes TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_url TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS downloaded_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Fix legacy constraints on invoices table to support multi-versioning (v1.0, v2.0) with same invoice number
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_invoice_number_key;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_company_id_invoice_number_key;

-- Fix legacy constraint on ar_collection_schedules to support both customer_id from customers and users tables
ALTER TABLE ar_collection_schedules DROP CONSTRAINT IF EXISTS ar_collection_schedules_customer_id_fkey;

-- 4. Line Items Table (Granular billing line items)
CREATE TABLE IF NOT EXISTS invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_type VARCHAR(50) NOT NULL, -- labour, material, equipment, transport, extra
  description TEXT NOT NULL,
  hsn_code VARCHAR(20) DEFAULT '998311',
  quantity NUMERIC(10,2) DEFAULT 1.00,
  unit_price NUMERIC(15,2) DEFAULT 0.00,
  total_amount NUMERIC(15,2) DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Customer Disputes / Issues Table
CREATE TABLE IF NOT EXISTS invoice_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id),
  issue_category VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'open',
  resolved_in_version INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Activity & Download Tracking Log Table
CREATE TABLE IF NOT EXISTS invoice_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  action_type VARCHAR(50) NOT NULL, -- viewed, downloaded, shared_whatsapp, shared_email
  version_number INT DEFAULT 1,
  performed_by_type VARCHAR(50) NOT NULL, -- customer, owner, employee
  performed_by_id UUID,
  performed_by_name VARCHAR(255),
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Payment Receipts Log Table
CREATE TABLE IF NOT EXISTS invoice_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payment_method VARCHAR(50) NOT NULL, -- razorpay, cash, bank_transfer, cheque, upi
  transaction_reference VARCHAR(255),
  amount NUMERIC(15,2) NOT NULL,
  payment_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  notes TEXT,
  recorded_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Indexes for High-Speed Query Performance
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(company_id, status);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_disputes_invoice ON invoice_disputes(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_activity_invoice ON invoice_activity_logs(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id);

-- 9. Row-Level Security (RLS) Policies
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_invoices ON invoices;
CREATE POLICY tenant_isolation_invoices ON invoices
  FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_invoice_items ON invoice_items;
CREATE POLICY tenant_isolation_invoice_items ON invoice_items
  FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_invoice_disputes ON invoice_disputes;
CREATE POLICY tenant_isolation_invoice_disputes ON invoice_disputes
  FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_invoice_activity ON invoice_activity_logs;
CREATE POLICY tenant_isolation_invoice_activity ON invoice_activity_logs
  FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_invoice_payments ON invoice_payments;
CREATE POLICY tenant_isolation_invoice_payments ON invoice_payments
  FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));
