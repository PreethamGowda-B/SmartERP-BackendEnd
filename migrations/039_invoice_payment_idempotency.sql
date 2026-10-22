-- Controlled migration only. It is excluded from application startup and must
-- run through the checksum-aware forward runner after isolated-database
-- preflight and explicit rollout approval.
BEGIN;

ALTER TABLE invoice_payments
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64),
  ADD COLUMN IF NOT EXISTS result_status VARCHAR(30),
  ADD COLUMN IF NOT EXISTS result_amount_paid NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS result_amount_due NUMERIC(15,2);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_payments_company_idempotency
  ON invoice_payments(company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoice_payments_idempotency_result_check'
      AND conrelid = 'invoice_payments'::regclass
  ) THEN
    ALTER TABLE invoice_payments
      ADD CONSTRAINT invoice_payments_idempotency_result_check CHECK (
        (idempotency_key IS NULL AND request_fingerprint IS NULL AND result_status IS NULL
          AND result_amount_paid IS NULL AND result_amount_due IS NULL)
        OR
        (idempotency_key IS NOT NULL AND length(idempotency_key) BETWEEN 8 AND 128
          AND request_fingerprint IS NOT NULL AND length(request_fingerprint) = 64
          AND result_status IS NOT NULL AND result_amount_paid IS NOT NULL AND result_amount_due IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;

COMMIT;
