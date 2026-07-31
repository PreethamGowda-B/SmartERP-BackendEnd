-- ====================================================================
-- SmartERP Migration 009: Payroll Pre-Run Validation Schema & RLS Policies
-- ====================================================================

-- 1. Create Custom Enums
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payroll_risk_level') THEN
        CREATE TYPE payroll_risk_level AS ENUM ('low', 'warning', 'critical');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payroll_flag_type') THEN
        CREATE TYPE payroll_flag_type AS ENUM ('duplicate_bank', 'salary_spike', 'inactive_user', 'attendance_mismatch', 'statutory_error', 'negative_payout', 'zero_salary');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payroll_flag_severity') THEN
        CREATE TYPE payroll_flag_severity AS ENUM ('info', 'warning', 'critical');
    END IF;
END $$;

-- 2. Payroll Validation Runs Table
CREATE TABLE IF NOT EXISTS payroll_validation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  month INT NOT NULL,
  year INT NOT NULL,
  total_employees_checked INT DEFAULT 0,
  total_anomalies_found INT DEFAULT 0,
  risk_level payroll_risk_level DEFAULT 'low',
  is_approved BOOLEAN DEFAULT FALSE,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT unq_company_payroll_period UNIQUE(company_id, month, year)
);

-- 3. Payroll Validation Anomaly Flags Table
CREATE TABLE IF NOT EXISTS payroll_validation_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  validation_run_id UUID NOT NULL REFERENCES payroll_validation_runs(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  employee_name VARCHAR(255),
  flag_type payroll_flag_type NOT NULL,
  severity payroll_flag_severity DEFAULT 'warning',
  description TEXT NOT NULL,
  ai_analysis_reasoning TEXT,
  is_resolved BOOLEAN DEFAULT FALSE,
  resolution_notes TEXT,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_payroll_val_runs_period ON payroll_validation_runs(company_id, month, year);
CREATE INDEX IF NOT EXISTS idx_payroll_val_flags_run ON payroll_validation_flags(validation_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_val_flags_type ON payroll_validation_flags(company_id, flag_type);

-- 5. Row-Level Security (RLS) Policies
ALTER TABLE payroll_validation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_validation_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_payroll_val_runs ON payroll_validation_runs;
CREATE POLICY tenant_isolation_payroll_val_runs ON payroll_validation_runs FOR ALL USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_payroll_val_flags ON payroll_validation_flags;
CREATE POLICY tenant_isolation_payroll_val_flags ON payroll_validation_flags FOR ALL USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
