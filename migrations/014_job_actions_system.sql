-- ===============================
-- SmartERP Migration 014: Unified Job Actions System
-- Field Actions, Assistance Requests, Blocker Reports & Escalations
-- ===============================

CREATE TABLE IF NOT EXISTS job_actions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  company_id        TEXT NOT NULL,
  performed_by      UUID NOT NULL REFERENCES users(id),
  module            VARCHAR(50) NOT NULL, -- 'status', 'assistance', 'material', 'expense', 'evidence', 'safety'
  action_type       VARCHAR(100) NOT NULL, -- 'need_workers', 'pause_work', 'site_blocker', 'upload_photo', 'log_expense', etc.
  urgency           VARCHAR(50) DEFAULT 'normal', -- 'low', 'normal', 'high', 'emergency'
  requires_approval BOOLEAN DEFAULT FALSE,
  status            VARCHAR(50) DEFAULT 'submitted', -- 'submitted', 'pending_approval', 'approved', 'rejected', 'completed'
  notes             TEXT,
  evidence_urls     JSONB DEFAULT '[]',
  payload           JSONB DEFAULT '{}', -- E.g. { worker_count: 2, expense_amount: 450, pause_reason: 'Rain' }
  owner_response    TEXT,
  resolved_by       UUID REFERENCES users(id),
  resolved_at       TIMESTAMP,
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_actions_job_id     ON job_actions(job_id);
CREATE INDEX IF NOT EXISTS idx_job_actions_company_id ON job_actions(company_id);
CREATE INDEX IF NOT EXISTS idx_job_actions_status     ON job_actions(company_id, status);
CREATE INDEX IF NOT EXISTS idx_job_actions_module     ON job_actions(module);
