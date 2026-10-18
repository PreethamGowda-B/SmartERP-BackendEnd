-- SmartERP 036: Customer component-manufacturing request intake and links.
-- Additive only. Applies after the reviewed Production & Dispatch schema (033-035).
-- Does not alter service jobs, invoice rows, inventory, or historical business records.

BEGIN;

CREATE TABLE IF NOT EXISTS customer_manufacturing_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  request_reference TEXT NOT NULL,
  component_name VARCHAR(200) NOT NULL,
  part_number VARCHAR(100),
  description TEXT NOT NULL,
  intended_application TEXT,
  material_specification TEXT,
  dimensions TEXT,
  tolerance TEXT,
  finish TEXT,
  drawing_number VARCHAR(100),
  drawing_revision VARCHAR(40),
  requested_quantity NUMERIC(14,3) NOT NULL CHECK (requested_quantity > 0),
  unit VARCHAR(24) NOT NULL,
  requested_completion_date DATE,
  delivery_preference VARCHAR(24) NOT NULL DEFAULT 'to_confirm'
    CHECK (delivery_preference IN ('delivery','pickup','to_confirm')),
  instructions TEXT,
  specification_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  attachment_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','clarification_required','approved','rejected','production_scheduled','in_production','quality_check','ready_for_dispatch','partially_dispatched','dispatched','completed','cancelled')),
  owner_response TEXT,
  confirmed_due_date DATE,
  commercial_status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (commercial_status IN ('pending','confirmed','not_required')),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, request_reference),
  UNIQUE (company_id, customer_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS customer_manufacturing_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  request_id UUID NOT NULL REFERENCES customer_manufacturing_requests(id) ON DELETE RESTRICT,
  actor_id TEXT,
  actor_type VARCHAR(16) NOT NULL CHECK (actor_type IN ('customer','owner','admin','employee','system')),
  event_type VARCHAR(48) NOT NULL,
  from_status VARCHAR(32),
  to_status VARCHAR(32),
  message TEXT,
  customer_visible BOOLEAN NOT NULL DEFAULT TRUE,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_manufacturing_production_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  request_id UUID NOT NULL REFERENCES customer_manufacturing_requests(id) ON DELETE RESTRICT,
  production_order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  linked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, request_id),
  UNIQUE (company_id, production_order_id)
);

CREATE TABLE IF NOT EXISTS production_order_invoice_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  production_order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  linked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, production_order_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_mfg_requests_company_status_created
  ON customer_manufacturing_requests (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfg_requests_customer_created
  ON customer_manufacturing_requests (company_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfg_events_request_created
  ON customer_manufacturing_request_events (company_id, request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mfg_production_link_order
  ON customer_manufacturing_production_links (company_id, production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_invoice_link_order
  ON production_order_invoice_links (company_id, production_order_id, linked_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_invoice_link_invoice
  ON production_order_invoice_links (company_id, invoice_id);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_manufacturing_requests',
    'customer_manufacturing_request_events',
    'customer_manufacturing_production_links',
    'production_order_invoice_links'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (current_setting(''app.bypass_rls'', true) = ''on'' OR company_id = current_setting(''app.current_company_id'', true)) WITH CHECK (current_setting(''app.bypass_rls'', true) = ''on'' OR company_id = current_setting(''app.current_company_id'', true))',
      table_name || '_company_isolation', table_name
    );
  END LOOP;
END $$;

-- Clear any database-level default ACLs first. CREATE TABLE can inherit broad
-- privileges from ALTER DEFAULT PRIVILEGES, and GRANT alone does not narrow them.
REVOKE ALL ON customer_manufacturing_requests, customer_manufacturing_request_events,
  customer_manufacturing_production_links, production_order_invoice_links FROM smarterp_app;

GRANT SELECT, INSERT, UPDATE ON customer_manufacturing_requests TO smarterp_app;
GRANT SELECT, INSERT ON customer_manufacturing_request_events TO smarterp_app;
GRANT SELECT, INSERT ON customer_manufacturing_production_links TO smarterp_app;
GRANT SELECT, INSERT ON production_order_invoice_links TO smarterp_app;

REVOKE ALL ON customer_manufacturing_requests, customer_manufacturing_request_events,
  customer_manufacturing_production_links, production_order_invoice_links FROM PUBLIC;
REVOKE ALL ON customer_manufacturing_requests, customer_manufacturing_request_events,
  customer_manufacturing_production_links, production_order_invoice_links FROM anon, authenticated, service_role;

COMMIT;
