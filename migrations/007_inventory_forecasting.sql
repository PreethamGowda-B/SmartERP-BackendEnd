-- ====================================================================
-- SmartERP Migration 007: Agentic Inventory Forecasting & PO Schema + RLS
-- ====================================================================

-- 1. Create Enums
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'po_status') THEN
        CREATE TYPE po_status AS ENUM ('draft', 'pending_approval', 'sent_to_supplier', 'partially_received', 'completed', 'cancelled');
    END IF;
END $$;

-- 2. Suppliers Directory Table
CREATE TABLE IF NOT EXISTS inventory_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_name VARCHAR(255) NOT NULL,
  contact_person VARCHAR(255),
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  address TEXT,
  gstin VARCHAR(15),
  default_lead_time_days INT DEFAULT 7,
  min_order_quantity NUMERIC(15,2) DEFAULT 1.00,
  rating NUMERIC(3,2) DEFAULT 5.00,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Inventory Forecasts & Dynamic ROP Table
CREATE TABLE IF NOT EXISTS inventory_forecasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id INT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  daily_usage_rate NUMERIC(15,4) DEFAULT 0.0000,
  safety_stock NUMERIC(15,2) DEFAULT 0.00,
  reorder_point NUMERIC(15,2) DEFAULT 0.00,
  economic_order_quantity NUMERIC(15,2) DEFAULT 0.00,
  predicted_30d_demand NUMERIC(15,2) DEFAULT 0.00,
  is_rop_breached BOOLEAN DEFAULT FALSE,
  last_calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT unq_item_forecast UNIQUE(company_id, item_id)
);

-- 4. Purchase Orders Header Table
CREATE TABLE IF NOT EXISTS inventory_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES inventory_suppliers(id),
  created_by UUID REFERENCES users(id),
  po_number VARCHAR(100) NOT NULL,
  status po_status DEFAULT 'draft',
  total_amount NUMERIC(15,2) DEFAULT 0.00,
  is_ai_generated BOOLEAN DEFAULT FALSE,
  ai_generation_reasoning TEXT,
  expected_delivery_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT unq_company_po_number UNIQUE(company_id, po_number)
);

-- 5. Purchase Order Items Table
CREATE TABLE IF NOT EXISTS inventory_po_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES inventory_purchase_orders(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id INT NOT NULL REFERENCES inventory_items(id),
  quantity_ordered NUMERIC(15,2) NOT NULL,
  quantity_received NUMERIC(15,2) DEFAULT 0.00,
  unit_price NUMERIC(15,2) NOT NULL,
  total_price NUMERIC(15,2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_inv_suppliers_company ON inventory_suppliers(company_id);
CREATE INDEX IF NOT EXISTS idx_inv_forecasts_company_item ON inventory_forecasts(company_id, item_id);
CREATE INDEX IF NOT EXISTS idx_inv_forecasts_breached ON inventory_forecasts(company_id, is_rop_breached);
CREATE INDEX IF NOT EXISTS idx_inv_po_company_status ON inventory_purchase_orders(company_id, status);

-- 7. Row-Level Security (RLS) Policies
ALTER TABLE inventory_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_po_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_suppliers ON inventory_suppliers;
CREATE POLICY tenant_isolation_suppliers ON inventory_suppliers FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_forecasts ON inventory_forecasts;
CREATE POLICY tenant_isolation_forecasts ON inventory_forecasts FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_po ON inventory_purchase_orders;
CREATE POLICY tenant_isolation_po ON inventory_purchase_orders FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_po_items ON inventory_po_items;
CREATE POLICY tenant_isolation_po_items ON inventory_po_items FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));
