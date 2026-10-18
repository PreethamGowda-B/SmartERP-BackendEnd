-- SmartERP Production & Dispatch schema proposal (additive only).
--
-- IMPORTANT: Do not add this file to the server-startup migration list or execute
-- it until the supported schema baseline and a disposable PostgreSQL test target
-- have been approved. External legacy IDs are stored as text because the tracked
-- schema and migrations disagree about their concrete types. The API validates
-- every external reference against the authenticated company before writing.

BEGIN;

CREATE TABLE IF NOT EXISTS production_sequences (
  company_id TEXT NOT NULL,
  sequence_kind TEXT NOT NULL CHECK (sequence_kind IN ('order', 'dispatch')),
  sequence_year INTEGER NOT NULL,
  next_value BIGINT NOT NULL DEFAULT 0 CHECK (next_value >= 0),
  PRIMARY KEY (company_id, sequence_kind, sequence_year)
);

CREATE TABLE IF NOT EXISTS production_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_order_reference TEXT,
  component_name VARCHAR(200) NOT NULL,
  part_number VARCHAR(100) NOT NULL,
  drawing_number VARCHAR(100),
  drawing_revision VARCHAR(40),
  planned_quantity NUMERIC(14,3) NOT NULL CHECK (planned_quantity > 0),
  unit VARCHAR(24) NOT NULL,
  due_date DATE NOT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  machine_id TEXT,
  assigned_employee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  job_id TEXT,
  instructions TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_production','quality_check','ready_for_dispatch','partially_dispatched','dispatched','on_hold','rework_required','rejected','cancelled')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, order_number)
);

CREATE TABLE IF NOT EXISTS production_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  batch_number INTEGER NOT NULL CHECK (batch_number > 0),
  operator_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  machine_id TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'in_production'
    CHECK (status IN ('in_production','submitted','inspected','cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, order_id, batch_number)
);

CREATE TABLE IF NOT EXISTS production_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES production_batches(id) ON DELETE RESTRICT,
  reported_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reported_by_name TEXT NOT NULL,
  good_quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (good_quantity >= 0),
  rejected_quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  rework_quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (rework_quantity >= 0),
  notes TEXT,
  evidence_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS production_order_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  inventory_item_id TEXT NOT NULL,
  planned_quantity NUMERIC(14,3) NOT NULL CHECK (planned_quantity > 0),
  unit VARCHAR(24),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, order_id, inventory_item_id)
);

CREATE TABLE IF NOT EXISTS production_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES production_batches(id) ON DELETE RESTRICT,
  inspector_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  inspector_name TEXT NOT NULL,
  inspection_reference TEXT NOT NULL,
  submitted_quantity NUMERIC(14,3) NOT NULL CHECK (submitted_quantity > 0),
  accepted_quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (accepted_quantity >= 0),
  rejected_quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  rework_quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (rework_quantity >= 0),
  result VARCHAR(32) NOT NULL CHECK (result IN ('passed','partially_accepted','rework_required','rejected','mixed_rework_and_rejection')),
  reason TEXT,
  notes TEXT,
  measurements JSONB NOT NULL DEFAULT '[]'::jsonb,
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, inspection_reference),
  CHECK (accepted_quantity + rejected_quantity + rework_quantity = submitted_quantity)
);

CREATE TABLE IF NOT EXISTS production_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  dispatch_reference TEXT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  delivery_reference TEXT,
  carrier TEXT,
  transport_details TEXT,
  notes TEXT,
  confirmed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_by_name TEXT NOT NULL,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, dispatch_reference)
);

CREATE TABLE IF NOT EXISTS production_dispatch_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  dispatch_id UUID NOT NULL REFERENCES production_dispatches(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  quantity_delta NUMERIC(14,3) NOT NULL CHECK (quantity_delta <> 0),
  reason TEXT NOT NULL,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS production_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES production_batches(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  from_status VARCHAR(32),
  to_status VARCHAR(32),
  quantity NUMERIC(14,3),
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS production_idempotency (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope VARCHAR(160) NOT NULL,
  request_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, actor_id, scope, request_key)
);

CREATE INDEX IF NOT EXISTS idx_production_orders_company_status_due
  ON production_orders (company_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_production_orders_company_customer
  ON production_orders (company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_production_orders_company_part
  ON production_orders (company_id, part_number);
CREATE INDEX IF NOT EXISTS idx_production_orders_assignee
  ON production_orders (company_id, assigned_employee_id, status);
CREATE INDEX IF NOT EXISTS idx_production_batches_order
  ON production_batches (company_id, order_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_production_batches_one_active_order
  ON production_batches (company_id, order_id)
  WHERE status IN ('in_production','submitted');
CREATE INDEX IF NOT EXISTS idx_production_reports_order_batch
  ON production_reports (company_id, order_id, batch_id, reported_at);
CREATE INDEX IF NOT EXISTS idx_production_inspections_order_batch
  ON production_inspections (company_id, order_id, batch_id, inspected_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_dispatches_order
  ON production_dispatches (company_id, order_id, dispatched_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_events_order
  ON production_events (company_id, order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_materials_order
  ON production_order_materials (company_id, order_id);

-- RLS is additive and fails closed when the authenticated tenant GUC is absent.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'production_sequences','production_orders','production_batches','production_reports',
    'production_order_materials','production_inspections','production_dispatches',
    'production_dispatch_adjustments','production_events','production_idempotency'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_tenant_policy', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (current_setting(''app.bypass_rls'', true) = ''on'' OR company_id = current_setting(''app.current_company_id'', true)) WITH CHECK (current_setting(''app.bypass_rls'', true) = ''on'' OR company_id = current_setting(''app.current_company_id'', true))',
      table_name || '_tenant_policy', table_name
    );
  END LOOP;
END $$;

-- The API switches to smarterp_app for tenant queries. Grant only the feature
-- tables, and only when the established least-privilege role already exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smarterp_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE production_sequences, production_orders, production_batches, production_reports, production_order_materials, production_inspections, production_dispatches, production_dispatch_adjustments, production_events, production_idempotency TO %I',
      'smarterp_app'
    );
  END IF;
END $$;

-- Append-only business facts cannot be rewritten or deleted through ordinary SQL.
CREATE OR REPLACE FUNCTION production_reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Production history is append-only; create a correction event instead.';
END;
$$;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'production_reports','production_inspections','production_dispatches',
    'production_dispatch_adjustments','production_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_append_only', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION production_reject_history_mutation()',
      table_name || '_append_only', table_name
    );
  END LOOP;
END $$;

COMMIT;
