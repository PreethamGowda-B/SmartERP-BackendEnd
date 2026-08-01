-- ====================================================================
-- SmartERP Migration 010: Autonomous CRM Pipeline & AI Sales Agent Schema + RLS
-- ====================================================================

-- 1. Create Custom Enums
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_stage_enum') THEN
        CREATE TYPE lead_stage_enum AS ENUM ('new_lead', 'contacted', 'proposal_sent', 'negotiation', 'closed_won', 'closed_lost');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_priority_enum') THEN
        CREATE TYPE lead_priority_enum AS ENUM ('cold', 'warm', 'hot');
    END IF;
END $$;

-- 2. Enhanced CRM Leads Table
CREATE TABLE IF NOT EXISTS crm_leads_enhanced (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES users(id),
  lead_name VARCHAR(255) NOT NULL,
  company_name VARCHAR(255),
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  deal_value NUMERIC(15,2) DEFAULT 0.00,
  lead_score INT DEFAULT 50,
  priority lead_priority_enum DEFAULT 'warm',
  stage lead_stage_enum DEFAULT 'new_lead',
  ai_proposal_text TEXT,
  last_contacted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. CRM Lead Activity Log Table
CREATE TABLE IF NOT EXISTS crm_lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES crm_leads_enhanced(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id),
  activity_type VARCHAR(50) NOT NULL, -- 'call', 'email', 'whatsapp', 'proposal_generated', 'stage_change'
  notes TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_stage ON crm_leads_enhanced(company_id, stage);
CREATE INDEX IF NOT EXISTS idx_crm_leads_score ON crm_leads_enhanced(company_id, lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activities_lead ON crm_lead_activities(lead_id);

-- 5. Row-Level Security (RLS) Policies
ALTER TABLE crm_leads_enhanced ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_lead_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_crm_leads ON crm_leads_enhanced;
CREATE POLICY tenant_isolation_crm_leads ON crm_leads_enhanced FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_crm_activities ON crm_lead_activities;
CREATE POLICY tenant_isolation_crm_activities ON crm_lead_activities FOR ALL USING (company_id::text = NULLIF(current_setting('app.current_company_id', true), ''));
