-- Material purchase verification is a draft workflow. Stock is changed only
-- when an owner confirms physical receipt and the bill is finalized.
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS purchase_status TEXT;

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS source_reference TEXT;

CREATE TABLE IF NOT EXISTS material_purchase_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  material_request_id INTEGER NOT NULL REFERENCES material_requests(id),
  requested_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  version INTEGER NOT NULL CHECK (version > 0),
  file_name TEXT NOT NULL,
  file_mime TEXT NOT NULL CHECK (file_mime IN ('application/pdf','image/jpeg','image/png')),
  file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 10485760),
  file_sha256 CHAR(64) NOT NULL,
  file_data BYTEA NOT NULL,
  supplier_name TEXT,
  invoice_number TEXT,
  invoice_date DATE,
  purchased_quantity NUMERIC,
  purchased_unit TEXT,
  unit_price NUMERIC,
  subtotal NUMERIC,
  discount_amount NUMERIC,
  tax_amount NUMERIC,
  invoice_total NUMERIC,
  currency TEXT,
  supplier_gstin TEXT,
  notes TEXT,
  extraction JSONB NOT NULL DEFAULT '{}'::jsonb,
  discrepancies JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_status TEXT NOT NULL DEFAULT 'processing' CHECK (ai_status IN ('processing','ai_verification_passed','review_required','ai_verification_failed','unable_to_analyse')),
  draft_status TEXT NOT NULL DEFAULT 'awaiting_owner_verification' CHECK (draft_status IN ('awaiting_owner_verification','correction_required','rejected','superseded','verified')),
  matched_inventory_item_id INTEGER REFERENCES inventory_items(id),
  rejection_reason TEXT,
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  receipt_transaction_id UUID,
  received_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, material_request_id, version)
);
CREATE INDEX IF NOT EXISTS idx_material_purchase_bills_request
  ON material_purchase_bills(company_id, material_request_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_material_purchase_bills_invoice
  ON material_purchase_bills(company_id, LOWER(TRIM(invoice_number))) WHERE invoice_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_material_purchase_bills_company_file_hash
  ON material_purchase_bills(company_id, file_sha256);

CREATE TABLE IF NOT EXISTS inventory_stock_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('receipt','issue','return','adjustment')),
  source_type TEXT NOT NULL CHECK (source_type IN ('manual_inventory_entry','material_request_receipt','material_issue','return','adjustment')),
  source_reference TEXT,
  material_request_id INTEGER REFERENCES material_requests(id),
  purchase_bill_id UUID REFERENCES material_purchase_bills(id),
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  unit TEXT,
  invoice_number TEXT,
  performed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((transaction_type = 'receipt' AND source_type = 'material_request_receipt' AND purchase_bill_id IS NOT NULL)
      OR NOT (transaction_type = 'receipt' AND source_type = 'material_request_receipt'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_stock_receipt_bill_once
  ON inventory_stock_transactions(purchase_bill_id)
  WHERE purchase_bill_id IS NOT NULL AND transaction_type = 'receipt';
CREATE INDEX IF NOT EXISTS idx_inventory_stock_item_history
  ON inventory_stock_transactions(company_id, inventory_item_id, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'material_purchase_bills_receipt_fk') THEN
    ALTER TABLE material_purchase_bills
      ADD CONSTRAINT material_purchase_bills_receipt_fk
      FOREIGN KEY (receipt_transaction_id) REFERENCES inventory_stock_transactions(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS material_purchase_events (
  id BIGSERIAL PRIMARY KEY,
  company_id TEXT NOT NULL,
  material_request_id INTEGER NOT NULL REFERENCES material_requests(id),
  purchase_bill_id UUID REFERENCES material_purchase_bills(id),
  actor_id UUID REFERENCES users(id),
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_material_purchase_events_request
  ON material_purchase_events(company_id, material_request_id, created_at);

ALTER TABLE material_purchase_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_purchase_bills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS material_purchase_bills_company_isolation ON material_purchase_bills;
CREATE POLICY material_purchase_bills_company_isolation ON material_purchase_bills FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR current_setting('app.current_role', true) = 'super_admin'
      OR current_setting('app.role', true) = 'admin_bypass'
      OR company_id = NULLIF(current_setting('app.current_company_id', true), ''))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR current_setting('app.current_role', true) = 'super_admin'
      OR current_setting('app.role', true) = 'admin_bypass'
      OR company_id = NULLIF(current_setting('app.current_company_id', true), ''));

ALTER TABLE material_purchase_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_purchase_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS material_purchase_events_company_isolation ON material_purchase_events;
CREATE POLICY material_purchase_events_company_isolation ON material_purchase_events FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR current_setting('app.current_role', true) = 'super_admin'
      OR current_setting('app.role', true) = 'admin_bypass'
      OR company_id = NULLIF(current_setting('app.current_company_id', true), ''))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR current_setting('app.current_role', true) = 'super_admin'
      OR current_setting('app.role', true) = 'admin_bypass'
      OR company_id = NULLIF(current_setting('app.current_company_id', true), ''));

ALTER TABLE inventory_stock_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_stock_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_stock_transactions_company_isolation ON inventory_stock_transactions;
CREATE POLICY inventory_stock_transactions_company_isolation ON inventory_stock_transactions FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR current_setting('app.current_role', true) = 'super_admin'
      OR current_setting('app.role', true) = 'admin_bypass'
      OR company_id = NULLIF(current_setting('app.current_company_id', true), ''))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR current_setting('app.current_role', true) = 'super_admin'
      OR current_setting('app.role', true) = 'admin_bypass'
      OR company_id = NULLIF(current_setting('app.current_company_id', true), ''));
