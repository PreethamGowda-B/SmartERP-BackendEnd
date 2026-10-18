-- SmartERP migration 035: company-scoped packing and employee dispatch workflow.
-- Additive only: historical dispatch rows remain valid with a NULL packing_record_id.

BEGIN;

ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS dispatch_employee_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_orders_dispatch_employee_fk'
      AND conrelid = 'production_orders'::regclass
  ) THEN
    ALTER TABLE production_orders
      ADD CONSTRAINT production_orders_dispatch_employee_fk
      FOREIGN KEY (dispatch_employee_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS production_packing_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  inspection_id UUID NOT NULL REFERENCES production_inspections(id) ON DELETE RESTRICT,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  package_count INTEGER NOT NULL DEFAULT 1 CHECK (package_count > 0),
  package_type VARCHAR(100),
  status VARCHAR(32) NOT NULL DEFAULT 'packing'
    CHECK (status IN ('packing','packed','ready_for_dispatch')),
  notes TEXT,
  recorded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE production_dispatches
  ADD COLUMN IF NOT EXISTS packing_record_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_dispatches_packing_record_fk'
      AND conrelid = 'production_dispatches'::regclass
  ) THEN
    ALTER TABLE production_dispatches
      ADD CONSTRAINT production_dispatches_packing_record_fk
      FOREIGN KEY (packing_record_id) REFERENCES production_packing_records(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_production_orders_dispatch_employee
  ON production_orders(company_id, dispatch_employee_id, status);
CREATE INDEX IF NOT EXISTS idx_production_packing_order
  ON production_packing_records(company_id, order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_packing_inspection
  ON production_packing_records(company_id, inspection_id, status);
CREATE INDEX IF NOT EXISTS idx_production_dispatches_packing
  ON production_dispatches(company_id, packing_record_id, dispatched_at DESC)
  WHERE packing_record_id IS NOT NULL;

ALTER TABLE production_packing_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS production_packing_records_tenant_policy ON production_packing_records;
CREATE POLICY production_packing_records_tenant_policy ON production_packing_records
  FOR ALL TO PUBLIC
  USING (current_setting('app.bypass_rls', true) = 'on'
         OR company_id = current_setting('app.current_company_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
              OR company_id = current_setting('app.current_company_id', true));

REVOKE ALL PRIVILEGES ON TABLE production_packing_records FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','smarterp_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE production_packing_records FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON TABLE production_packing_records TO smarterp_app;

COMMIT;
