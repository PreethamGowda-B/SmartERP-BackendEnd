-- 022_cnc_phase3.sql
-- SmartERP CNC Service Edition — Phase 3 Enterprise Intelligence & AI Agent Workflows

-- 1. Zero-Code Automation Rules Table
CREATE TABLE IF NOT EXISTS automation_rules (
  id SERIAL PRIMARY KEY,
  company_id TEXT NOT NULL,
  rule_name VARCHAR(255) NOT NULL,
  trigger_event VARCHAR(100) NOT NULL, -- e.g. 'machine_health_low', 'sla_warning', 'amc_expiry'
  condition_json JSONB DEFAULT '{}',
  action_type VARCHAR(100) NOT NULL, -- e.g. 'auto_pm', 'notify_owner', 'reserve_part'
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_company ON automation_rules(company_id);

-- 2. AI Company Operational Memory Table
CREATE TABLE IF NOT EXISTS ai_company_memory (
  id SERIAL PRIMARY KEY,
  company_id TEXT NOT NULL,
  category VARCHAR(100) NOT NULL, -- 'preferred_engineers', 'frequent_alarms', 'spare_suppliers'
  context_key VARCHAR(255) NOT NULL,
  context_value JSONB NOT NULL,
  confidence_score NUMERIC(5, 2) DEFAULT 0.95,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_company_memory_company ON ai_company_memory(company_id);

-- 3. AI Action Immutable Audit Trail & Activity Center Table
CREATE TABLE IF NOT EXISTS ai_action_audit_trail (
  id SERIAL PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id UUID,
  user_name VARCHAR(255),
  prompt TEXT NOT NULL,
  ai_interpretation TEXT,
  workflow_type VARCHAR(100) NOT NULL, -- 'breakdown_flow', 'pm_flow', 'quotation_flow', 'warranty_flow'
  execution_level INTEGER DEFAULT 1, -- 1: Immediate, 2: Confirmation, 3: Explicit Owner Approval
  approval_status VARCHAR(50) DEFAULT 'executed', -- 'executed', 'pending_approval', 'approved', 'rejected'
  api_calls_made JSONB DEFAULT '[]',
  modules_updated JSONB DEFAULT '[]',
  result_summary TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_company ON ai_action_audit_trail(company_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_status ON ai_action_audit_trail(approval_status);

-- 4. Predictive Alerts Table
CREATE TABLE IF NOT EXISTS predictive_alerts (
  id SERIAL PRIMARY KEY,
  company_id TEXT NOT NULL,
  machine_id INTEGER REFERENCES customer_machines(id) ON DELETE CASCADE,
  alert_type VARCHAR(100) NOT NULL, -- 'health_decline', 'alarm_repetition', 'amc_expiring', 'stock_low'
  severity VARCHAR(50) DEFAULT 'warning', -- 'info', 'warning', 'critical'
  title VARCHAR(255) NOT NULL,
  description TEXT,
  recommended_action VARCHAR(255),
  is_resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_predictive_alerts_company ON predictive_alerts(company_id);
