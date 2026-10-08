-- Migration 016: Direct & Walk-in Invoices
-- Enables counter and direct invoicing without requiring a pre-existing job

-- 1. Allow job_id to be NULL
ALTER TABLE invoices ALTER COLUMN job_id DROP NOT NULL;

-- 2. Add walk-in / direct metadata columns
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_type VARCHAR(50) DEFAULT 'job';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_address TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_gstin VARCHAR(50);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);

-- 3. Composite index for filtering by invoice_type within tenant
CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(company_id, invoice_type);
