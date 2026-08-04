-- Migration 019: Workforce Gatekeeper Audit Logs
CREATE TABLE IF NOT EXISTS workforce_gatekeeper_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'employee',
  job_id TEXT,
  attempted_operation VARCHAR(100) NOT NULL,
  restriction_code VARCHAR(50) NOT NULL,
  restriction_reason TEXT,
  ip_address VARCHAR(100),
  device VARCHAR(255),
  browser VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gatekeeper_logs_company ON workforce_gatekeeper_audit_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_gatekeeper_logs_user ON workforce_gatekeeper_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_gatekeeper_logs_job ON workforce_gatekeeper_audit_logs(job_id);
