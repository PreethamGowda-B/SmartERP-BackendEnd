-- Phase 10 proposed additive rollout draft.
-- Intentionally not registered with an automatic migration runner.
-- Apply only after isolated-database preflight and owner approval.
-- Never run this script against a production database without explicit authorization.

BEGIN;

-- 1. Add request_fingerprint column to invoices (nullable, non-breaking for existing rows)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64);

-- 2. Partial unique index to enforce idempotency per company
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_company_idempotency
  ON invoices(company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3. Validation constraint: enforces coherent fingerprint when idempotency_key is present
-- Marked NOT VALID so historical rows are not locked or failed during rollout
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoices_idempotency_fingerprint_check'
      AND conrelid = 'invoices'::regclass
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_idempotency_fingerprint_check CHECK (
        (idempotency_key IS NULL AND request_fingerprint IS NULL)
        OR
        (idempotency_key IS NOT NULL AND length(idempotency_key) BETWEEN 8 AND 128
          AND request_fingerprint IS NOT NULL AND length(request_fingerprint) = 64)
      ) NOT VALID;
  END IF;
END $$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- SAFE ROLLBACK PROCEDURE (NON-DESTRUCTIVE):
-- To revert without deleting or modifying any invoice data:
--
-- BEGIN;
-- ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_idempotency_fingerprint_check;
-- DROP INDEX IF EXISTS idx_invoices_company_idempotency;
-- -- Retain the request_fingerprint column to avoid destructive data rewrites.
-- COMMIT;
-- ─────────────────────────────────────────────────────────────────────────────
