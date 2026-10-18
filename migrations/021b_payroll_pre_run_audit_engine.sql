-- Upgrade payroll audit history to support independent executions and truthful check states.
-- No payroll records or existing audit findings are deleted by this migration.
BEGIN;

ALTER TABLE payroll_validation_runs
  ADD COLUMN IF NOT EXISTS audit_status VARCHAR(40) NOT NULL DEFAULT 'processing',
  ADD COLUMN IF NOT EXISTS record_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checks_executed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS check_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS payroll_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE payroll_validation_flags
  ADD COLUMN IF NOT EXISTS source_table TEXT,
  ADD COLUMN IF NOT EXISTS source_record_id TEXT,
  ADD COLUMN IF NOT EXISTS finding_details JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The current application supports UUID company IDs and legacy numeric IDs.
-- Validation history stores the canonical ID as text so either deployment schema works.
ALTER TABLE payroll_validation_runs DROP CONSTRAINT IF EXISTS payroll_validation_runs_company_id_fkey;
ALTER TABLE payroll_validation_flags DROP CONSTRAINT IF EXISTS payroll_validation_flags_company_id_fkey;
ALTER TABLE payroll_validation_runs DROP CONSTRAINT IF EXISTS unq_company_payroll_period;
ALTER TABLE payroll_validation_runs ALTER COLUMN company_id TYPE TEXT USING company_id::text;
ALTER TABLE payroll_validation_flags ALTER COLUMN company_id TYPE TEXT USING company_id::text;

CREATE INDEX IF NOT EXISTS idx_payroll_val_runs_period_created
  ON payroll_validation_runs(company_id, year DESC, month DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_val_flags_source
  ON payroll_validation_flags(company_id, source_table, source_record_id);

COMMIT;
