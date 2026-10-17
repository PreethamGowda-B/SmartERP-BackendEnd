-- Additive invoice idempotency key for retried direct/walk-in submissions.
-- Existing invoices remain untouched; rows without keys are unaffected.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_company_idempotency
  ON invoices(company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
