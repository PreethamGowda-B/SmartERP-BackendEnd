-- ====================================================================
-- SmartERP Migration 006: GST Reconciliation Agent Engine & RLS Policies
-- ====================================================================

-- 1. Create Custom Enums (Safe create)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gst_reconcile_status') THEN
        CREATE TYPE gst_reconcile_status AS ENUM ('draft', 'processing', 'completed', 'failed');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gst_match_status') THEN
        CREATE TYPE gst_match_status AS ENUM ('exact_match', 'fuzzy_match', 'tax_mismatch', 'missing_in_gstr', 'missing_in_books', 'manual_overridden');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gst_vendor_status') THEN
        CREATE TYPE gst_vendor_status AS ENUM ('compliant', 'warning', 'blocked');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gstr_doc_type') THEN
        CREATE TYPE gstr_doc_type AS ENUM ('GSTR_2A', 'GSTR_2B');
    END IF;
END $$;

-- 2. Company GST Settings Table
CREATE TABLE IF NOT EXISTS gst_company_settings (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  is_auto_payment_block_enabled BOOLEAN DEFAULT FALSE,
  auto_approve_confidence_threshold NUMERIC(5,2) DEFAULT 90.00,
  canonical_tolerance_amount NUMERIC(10,2) DEFAULT 5.00,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Header Table: Main Reconciliation Session
CREATE TABLE IF NOT EXISTS gst_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  financial_period VARCHAR(7) NOT NULL, -- YYYY-MM
  gstr_type gstr_doc_type NOT NULL DEFAULT 'GSTR_2B',
  version INT DEFAULT 1,
  is_latest BOOLEAN DEFAULT TRUE,
  total_books_invoices INT DEFAULT 0,
  total_portal_invoices INT DEFAULT 0,
  total_matched INT DEFAULT 0,
  total_mismatched INT DEFAULT 0,
  total_itc_claimed NUMERIC(15,2) DEFAULT 0.00,
  total_itc_blocked NUMERIC(15,2) DEFAULT 0.00,
  raw_payload_s3_key TEXT,
  raw_payload_expires_at TIMESTAMP WITH TIME ZONE,
  status gst_reconcile_status DEFAULT 'draft',
  summary_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT unq_company_period_type_version UNIQUE(company_id, financial_period, gstr_type, version)
);

-- 4. Detail Table: Line-Item Reconciliation Records
CREATE TABLE IF NOT EXISTS gst_reconciliation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_run_id UUID NOT NULL REFERENCES gst_reconciliation_runs(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_gstin VARCHAR(15) NOT NULL,
  supplier_name VARCHAR(255),
  invoice_number_books VARCHAR(100),
  invoice_number_portal VARCHAR(100),
  invoice_date_books DATE,
  invoice_date_portal DATE,
  taxable_value_books NUMERIC(15,2) DEFAULT 0.00,
  taxable_value_portal NUMERIC(15,2) DEFAULT 0.00,
  cgst_books NUMERIC(15,2) DEFAULT 0.00,
  cgst_portal NUMERIC(15,2) DEFAULT 0.00,
  sgst_books NUMERIC(15,2) DEFAULT 0.00,
  sgst_portal NUMERIC(15,2) DEFAULT 0.00,
  igst_books NUMERIC(15,2) DEFAULT 0.00,
  igst_portal NUMERIC(15,2) DEFAULT 0.00,
  variance_amount NUMERIC(15,2) DEFAULT 0.00,
  match_status gst_match_status DEFAULT 'missing_in_gstr',
  confidence_score NUMERIC(5,2) DEFAULT 0.00,
  ai_match_reasoning TEXT,
  vendor_notified BOOLEAN DEFAULT FALSE,
  vendor_notified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Vendor Compliance Rating Table
CREATE TABLE IF NOT EXISTS gst_vendor_compliance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_gstin VARCHAR(15) NOT NULL,
  supplier_name VARCHAR(255) NOT NULL,
  total_invoices_received INT DEFAULT 0,
  total_mismatched_invoices INT DEFAULT 0,
  compliance_score NUMERIC(5,2) DEFAULT 100.00,
  status gst_vendor_status DEFAULT 'compliant',
  last_evaluated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT unq_vendor_company_gstin UNIQUE(company_id, supplier_gstin)
);

-- 6. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_gst_run_company_period ON gst_reconciliation_runs(company_id, financial_period, is_latest);
CREATE INDEX IF NOT EXISTS idx_gst_items_run ON gst_reconciliation_items(reconciliation_run_id);
CREATE INDEX IF NOT EXISTS idx_gst_items_company_gstin ON gst_reconciliation_items(company_id, supplier_gstin);
CREATE INDEX IF NOT EXISTS idx_gst_items_match_status ON gst_reconciliation_items(company_id, match_status);

-- 7. PostgreSQL Row-Level Security (RLS) Policies (Defense-in-Depth)
ALTER TABLE gst_company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_reconciliation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_vendor_compliance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_gst_settings ON gst_company_settings;
CREATE POLICY tenant_isolation_gst_settings ON gst_company_settings
  FOR ALL USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_gst_runs ON gst_reconciliation_runs;
CREATE POLICY tenant_isolation_gst_runs ON gst_reconciliation_runs
  FOR ALL USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_gst_items ON gst_reconciliation_items;
CREATE POLICY tenant_isolation_gst_items ON gst_reconciliation_items
  FOR ALL USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_gst_compliance ON gst_vendor_compliance;
CREATE POLICY tenant_isolation_gst_compliance ON gst_vendor_compliance
  FOR ALL USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
