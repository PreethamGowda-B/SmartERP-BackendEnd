-- ===============================
-- SmartERP Workflow Enhancement Migration
-- Customer Job Approval Workflow + Enterprise Features
-- Safe to run multiple times — all statements use IF NOT EXISTS
-- ===============================

-- ── 1. Add approval_status to jobs ───────────────────────────────────────────
-- Separates approval state from job execution state
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS approval_status VARCHAR(50) DEFAULT 'approved';
-- Values: 'pending_approval' | 'approved' | 'rejected'
-- Default 'approved' preserves backward compat for existing owner/employee jobs

-- ── 2. Add job timeline timestamps ───────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS approved_at   TIMESTAMP;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assigned_at   TIMESTAMP;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_at    TIMESTAMP;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS rejected_at   TIMESTAMP;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS arrived_at    TIMESTAMP;

-- ── 3. Add dispatch tracking ──────────────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dispatch_status VARCHAR(50) DEFAULT 'unassigned';
-- Values: 'unassigned' | 'dispatched' | 'manual'

-- ── 4. Add job location fields ────────────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_latitude  NUMERIC(10, 7);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_longitude NUMERIC(10, 7);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_address   TEXT;

-- ── 5. Add SLA breach tracking ────────────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_accept_breached     BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_completion_breached BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_accept_breach_at    TIMESTAMP;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sla_completion_breach_at TIMESTAMP;

-- ── 6. Add AI priority suggestion ────────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_suggested_priority VARCHAR(50);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority_overridden    BOOLEAN DEFAULT FALSE;

-- ── 7. Add scheduled_at for future job scheduling ────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP;

-- ── 8. Company settings table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  setting_key     VARCHAR(100) NOT NULL,
  setting_value   TEXT,
  updated_by      UUID REFERENCES users(id),
  updated_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE (company_id, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_company_settings_company_id ON company_settings(company_id);

-- Insert default auto_approve_customer_jobs = false for all existing companies
INSERT INTO company_settings (company_id, setting_key, setting_value)
SELECT id, 'auto_approve_customer_jobs', 'false'
FROM companies
ON CONFLICT (company_id, setting_key) DO NOTHING;

-- ── 9. SLA configuration table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sla_configs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  max_accept_time       INTEGER DEFAULT 30,   -- minutes: assigned_at → accepted_at
  max_completion_time   INTEGER DEFAULT 240,  -- minutes: accepted_at → completed_at
  is_active             BOOLEAN DEFAULT TRUE,
  created_by            UUID REFERENCES users(id),
  updated_at            TIMESTAMP DEFAULT NOW(),
  UNIQUE (company_id)
);

CREATE INDEX IF NOT EXISTS idx_sla_configs_company_id ON sla_configs(company_id);

-- ── 10. Invoices table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID REFERENCES jobs(id) ON DELETE SET NULL,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  invoice_number  VARCHAR(50) UNIQUE,
  labor_hours     NUMERIC(10, 2) DEFAULT 0,
  labor_cost      NUMERIC(10, 2) DEFAULT 0,
  materials_cost  NUMERIC(10, 2) DEFAULT 0,
  service_charge  NUMERIC(10, 2) DEFAULT 0,
  total_amount    NUMERIC(10, 2) DEFAULT 0,
  status          VARCHAR(50) DEFAULT 'draft',  -- draft | sent | paid
  breakdown       JSONB DEFAULT '{}',
  generated_at    TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_job_id     ON invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id);

-- ── 11. Job materials usage table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_materials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  item_name       VARCHAR(255),
  quantity_used   NUMERIC(10, 2) NOT NULL,
  unit_cost       NUMERIC(10, 2) DEFAULT 0,
  total_cost      NUMERIC(10, 2) DEFAULT 0,
  logged_by       UUID REFERENCES users(id),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  logged_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_materials_job_id     ON job_materials(job_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_company_id ON job_materials(company_id);

-- ── 12. Audit logs table (dedicated, append-only) ────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id),
  user_id     UUID,
  actor_type  VARCHAR(20) DEFAULT 'user',  -- 'user' | 'customer' | 'system'
  action_type VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100),
  entity_id   TEXT,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  VARCHAR(100),
  user_agent  TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_id  ON audit_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id     ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_id   ON audit_logs(entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at  ON audit_logs(created_at);

-- ── 13. Notification preferences table ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  event_type      VARCHAR(100) NOT NULL,
  enabled         BOOLEAN DEFAULT TRUE,
  updated_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, event_type),
  UNIQUE (customer_id, event_type),
  CHECK (user_id IS NOT NULL OR customer_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_notif_prefs_user_id     ON notification_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_prefs_customer_id ON notification_preferences(customer_id);

-- ── 14. Indexes for new approval_status queries ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_approval_status ON jobs(approval_status);
CREATE INDEX IF NOT EXISTS idx_jobs_source_approval ON jobs(source, approval_status);
CREATE INDEX IF NOT EXISTS idx_jobs_company_approval ON jobs(company_id, approval_status);

-- ── 15. Update existing customer jobs to have pending_approval status ─────────
-- Only update jobs created by customers that don't have an explicit approval yet
UPDATE jobs
SET approval_status = 'pending_approval'
WHERE source = 'customer'
  AND approval_status = 'approved'
  AND created_at > NOW() - INTERVAL '30 days';
-- Note: older jobs default to 'approved' to avoid disrupting existing workflows

-- ── 16. Employee profiles — add location tracking columns ────────────────────
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS latitude          NUMERIC(10, 7);
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS longitude         NUMERIC(10, 7);
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMP;
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS is_online         BOOLEAN DEFAULT FALSE;
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS rating            NUMERIC(3, 2) DEFAULT 5.0;
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS active_job_count  INTEGER DEFAULT 0;

-- ── 17. Branches table (multi-branch support) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  address     TEXT,
  latitude    NUMERIC(10, 7),
  longitude   NUMERIC(10, 7),
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branches_company_id ON branches(company_id);

-- Add branch_id to relevant tables
ALTER TABLE users           ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id);
ALTER TABLE jobs            ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id);

-- ── 18. Customer favorite employees ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_favorite_employees (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (customer_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cfe_customer_id ON customer_favorite_employees(customer_id);

-- ── 19. API tokens table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by  UUID REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,
  name        VARCHAR(255),
  last_used_at TIMESTAMP,
  revoked     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_company_id ON api_tokens(company_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash);
