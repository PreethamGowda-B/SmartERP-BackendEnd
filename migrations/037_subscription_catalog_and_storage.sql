-- Canonical subscription catalog plus tenant-scoped storage usage accounting.
-- Repeatable by design: plan rows are upserted by stable ID; no historical
-- subscription, event, invoice, or company records are rewritten.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_monthly NUMERIC(12,2);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_yearly NUMERIC(12,2);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_active_jobs INTEGER;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_storage_bytes BIGINT;

INSERT INTO plans
  (id, name, employee_limit, max_inventory_items, max_material_requests,
   messages_history_days, features, price_monthly, price_yearly,
   max_active_jobs, max_storage_bytes)
VALUES
  (1, 'Starter', 10, 50, NULL, 30,
   '{"payroll":false,"messages":true,"ai_assistant":false,"basic_reports":true,"export_reports":true,"advanced_reports":false,"inventory_images":false,"priority_support":false,"location_tracking":false,"ar_collections":false,"inventory_forecasts":false}'::jsonb,
   0, 0, 15, 262144000),
  (2, 'Professional', 50, 500, NULL, 30,
   '{"payroll":true,"messages":true,"ai_assistant":true,"basic_reports":true,"export_reports":true,"advanced_reports":true,"inventory_images":true,"priority_support":false,"location_tracking":true,"ar_collections":true,"inventory_forecasts":true}'::jsonb,
   999, 9990, 100, 5368709120),
  (3, 'Enterprise', NULL, NULL, NULL, 30,
   '{"payroll":true,"messages":true,"ai_assistant":true,"basic_reports":true,"export_reports":true,"advanced_reports":true,"inventory_images":true,"priority_support":false,"location_tracking":true,"ar_collections":true,"inventory_forecasts":true}'::jsonb,
   2499, 24990, NULL, NULL)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  employee_limit = EXCLUDED.employee_limit,
  max_inventory_items = EXCLUDED.max_inventory_items,
  max_material_requests = EXCLUDED.max_material_requests,
  messages_history_days = EXCLUDED.messages_history_days,
  features = EXCLUDED.features,
  price_monthly = EXCLUDED.price_monthly,
  price_yearly = EXCLUDED.price_yearly,
  max_active_jobs = EXCLUDED.max_active_jobs,
  max_storage_bytes = EXCLUDED.max_storage_bytes;

SELECT setval(pg_get_serial_sequence('plans', 'id'), GREATEST((SELECT MAX(id) FROM plans), 3), TRUE);

CREATE TABLE IF NOT EXISTS company_storage_usage (
  company_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
  source_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, storage_key)
);

-- companies.id is UUID in newer schema variants and INTEGER in the deployed
-- legacy schema. Match its actual PostgreSQL type so the FK remains enforced in
-- either supported deployment shape; do not coerce or rewrite company IDs.
DO $$
DECLARE
  company_id_type TEXT;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO company_id_type
    FROM pg_attribute a
   WHERE a.attrelid = 'public.companies'::regclass
     AND a.attname = 'id'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF company_id_type IS NULL OR company_id_type NOT IN ('integer', 'bigint', 'uuid') THEN
    RAISE EXCEPTION 'Unsupported companies.id type for subscription payment FKs: %', company_id_type;
  END IF;

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS subscription_payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id %s NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
      purpose TEXT NOT NULL CHECK (purpose IN ('plan_purchase', 'trial_activation')),
      plan_id INTEGER NOT NULL REFERENCES public.plans(id),
      billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly', 'trial')),
      razorpay_order_id TEXT NOT NULL UNIQUE,
      razorpay_payment_id TEXT,
      amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
      currency CHAR(3) NOT NULL CHECK (currency = 'INR'),
      status TEXT NOT NULL CHECK (status IN ('created', 'authorized', 'captured', 'failed', 'refunded', 'disputed')),
      provider_status TEXT,
      captured_at TIMESTAMPTZ,
      provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, company_id_type);

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS subscription_payment_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id %s NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
      razorpay_order_id TEXT NOT NULL REFERENCES public.subscription_payments(razorpay_order_id) ON DELETE RESTRICT,
      razorpay_payment_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('authorized', 'captured', 'failed')),
      amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
      currency CHAR(3) NOT NULL CHECK (currency = 'INR'),
      provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  $ddl$, company_id_type);
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_provider_payment
  ON subscription_payments(razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscription_payments_company_created
  ON subscription_payments(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_payment_attempts_company_created
  ON subscription_payment_attempts(company_id, created_at DESC);

-- Preserve the provider references already present in verified subscription
-- events as structured payment rows. Existing event and subscription history
-- remains untouched.
INSERT INTO subscription_payments
  (company_id, purpose, plan_id, billing_cycle, razorpay_order_id,
   razorpay_payment_id, amount_paise, currency, status, provider_status,
   captured_at, provider_payload, created_at, updated_at)
SELECT DISTINCT ON (metadata->>'razorpay_order_id')
       company_id,
       CASE WHEN event_type IN ('trial_payment_verified', 'trial_started') THEN 'trial_activation' ELSE 'plan_purchase' END,
       COALESCE(new_plan_id, CASE WHEN event_type IN ('trial_payment_verified', 'trial_started') THEN 3 END),
       COALESCE(metadata->>'billingCycle', metadata->>'billing_cycle', CASE WHEN event_type IN ('trial_payment_verified', 'trial_started') THEN 'trial' END),
       metadata->>'razorpay_order_id',
       metadata->>'razorpay_payment_id',
       CASE
         WHEN event_type IN ('trial_payment_verified', 'trial_started') THEN 100
         WHEN COALESCE(metadata->>'amount_paise', '') ~ '^[1-9][0-9]*$' THEN (metadata->>'amount_paise')::bigint
         ELSE NULL
       END,
       COALESCE(metadata->>'currency', 'INR'), 'captured', 'captured',
       created_at, metadata, created_at, created_at
  FROM subscription_events
 WHERE event_type IN ('upgrade', 'trial_payment_verified', 'trial_started')
   AND NULLIF(metadata->>'razorpay_order_id', '') IS NOT NULL
   AND NULLIF(metadata->>'razorpay_payment_id', '') IS NOT NULL
   AND (event_type IN ('trial_payment_verified', 'trial_started') OR
        (new_plan_id IN (2,3) AND COALESCE(metadata->>'amount_paise', '') ~ '^[1-9][0-9]*$'))
ON CONFLICT DO NOTHING;

INSERT INTO subscription_payment_attempts
  (company_id, razorpay_order_id, razorpay_payment_id, status,
   amount_paise, currency, provider_payload, created_at, updated_at)
SELECT company_id, razorpay_order_id, razorpay_payment_id, 'captured',
       amount_paise, currency, provider_payload, created_at, updated_at
  FROM subscription_payments
 WHERE status = 'captured' AND razorpay_payment_id IS NOT NULL
ON CONFLICT (razorpay_payment_id) DO NOTHING;

ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_payments_tenant ON subscription_payments;
CREATE POLICY subscription_payments_tenant ON subscription_payments FOR ALL
  USING (
    company_id::text = NULLIF(current_setting('app.current_company_id', TRUE), '')
    OR COALESCE(current_setting('app.bypass_rls', TRUE), 'false') = 'true'
  )
  WITH CHECK (
    company_id::text = NULLIF(current_setting('app.current_company_id', TRUE), '')
    OR COALESCE(current_setting('app.bypass_rls', TRUE), 'false') = 'true'
  );

ALTER TABLE subscription_payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payment_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_payment_attempts_tenant ON subscription_payment_attempts;
CREATE POLICY subscription_payment_attempts_tenant ON subscription_payment_attempts FOR ALL
  USING (
    company_id::text = NULLIF(current_setting('app.current_company_id', TRUE), '')
    OR COALESCE(current_setting('app.bypass_rls', TRUE), 'false') = 'true'
  )
  WITH CHECK (
    company_id::text = NULLIF(current_setting('app.current_company_id', TRUE), '')
    OR COALESCE(current_setting('app.bypass_rls', TRUE), 'false') = 'true'
  );

CREATE INDEX IF NOT EXISTS idx_company_storage_usage_company
  ON company_storage_usage(company_id);

-- Keep old files in quota accounting. Where the old schema did not retain a
-- size, charge the route's maximum accepted upload size rather than silently
-- giving existing files free storage.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_size_bytes BIGINT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_storage_key TEXT;
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS storage_key TEXT;

UPDATE inventory_items SET image_size_bytes = 5242880
 WHERE image_url IS NOT NULL AND COALESCE(image_size_bytes, 0) <= 0;
UPDATE inventory_items SET image_storage_key = 'inventory-image:' || id::text
 WHERE image_url IS NOT NULL AND image_storage_key IS NULL;
UPDATE employee_documents SET file_size_bytes = 10485760
 WHERE file_url IS NOT NULL AND COALESCE(file_size_bytes, 0) <= 0;
UPDATE employee_documents SET storage_key = 'employee-document:' || id::text
 WHERE file_url IS NOT NULL AND storage_key IS NULL;

INSERT INTO company_storage_usage(company_id, storage_key, file_size_bytes, source_type)
SELECT company_id::text, image_storage_key, image_size_bytes, 'inventory_image'
  FROM inventory_items
 WHERE company_id IS NOT NULL AND image_url IS NOT NULL AND image_size_bytes > 0 AND image_storage_key IS NOT NULL
ON CONFLICT (company_id, storage_key) DO NOTHING;

INSERT INTO company_storage_usage(company_id, storage_key, file_size_bytes, source_type)
SELECT company_id::text, storage_key, file_size_bytes, 'employee_document'
  FROM employee_documents
 WHERE company_id IS NOT NULL AND file_url IS NOT NULL AND file_size_bytes > 0 AND storage_key IS NOT NULL
ON CONFLICT (company_id, storage_key) DO NOTHING;

DO $$
BEGIN
  IF to_regclass('public.material_purchase_bills') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO company_storage_usage(company_id, storage_key, file_size_bytes, source_type)
      SELECT company_id::text, 'purchase-bill:' || id::text, file_size, 'material_purchase_bill'
        FROM material_purchase_bills
       WHERE company_id IS NOT NULL AND file_size > 0
      ON CONFLICT (company_id, storage_key) DO NOTHING
    $sql$;
  END IF;
  IF to_regclass('public.message_attachments') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO company_storage_usage(company_id, storage_key, file_size_bytes, source_type)
      SELECT company_id::text, 'message-attachment:' || id::text, file_size, 'message_attachment'
        FROM message_attachments
       WHERE company_id IS NOT NULL AND file_size > 0
      ON CONFLICT (company_id, storage_key) DO NOTHING
    $sql$;
  END IF;
  IF to_regclass('public.job_messages') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO company_storage_usage(company_id, storage_key, file_size_bytes, source_type)
      SELECT company_id::text, 'customer-chat:' || id::text, file_size, 'customer_chat_attachment'
        FROM job_messages
       WHERE company_id IS NOT NULL AND file_size > 0
      ON CONFLICT (company_id, storage_key) DO NOTHING
    $sql$;
  END IF;
  IF to_regclass('public.job_proof_of_work') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO company_storage_usage(company_id, storage_key, file_size_bytes, source_type)
      SELECT company_id::text, 'job-proof:' || id::text,
             GREATEST(1, ((length(photo_url) - strpos(photo_url, ',') - 1) * 3 / 4) -
               CASE WHEN right(photo_url, 2) = '==' THEN 2 WHEN right(photo_url, 1) = '=' THEN 1 ELSE 0 END),
             'job_proof_image'
        FROM job_proof_of_work
       WHERE company_id IS NOT NULL AND photo_url LIKE 'data:image/%;base64,%'
      ON CONFLICT (company_id, storage_key) DO NOTHING
    $sql$;
  END IF;
END $$;

ALTER TABLE company_storage_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_storage_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_storage_usage_tenant ON company_storage_usage;
CREATE POLICY company_storage_usage_tenant ON company_storage_usage FOR ALL
  USING (
    company_id = NULLIF(current_setting('app.current_company_id', TRUE), '')
    OR COALESCE(current_setting('app.bypass_rls', TRUE), 'false') = 'true'
  )
  WITH CHECK (
    company_id = NULLIF(current_setting('app.current_company_id', TRUE), '')
    OR COALESCE(current_setting('app.bypass_rls', TRUE), 'false') = 'true'
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smarterp_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON company_storage_usage TO smarterp_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON subscription_payments TO smarterp_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON subscription_payment_attempts TO smarterp_app';
  END IF;
END $$;
