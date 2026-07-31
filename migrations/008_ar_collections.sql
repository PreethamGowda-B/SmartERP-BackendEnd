-- ====================================================================
-- SmartERP Migration 008: Autonomous AR Collections Schema & RLS Policies
-- ====================================================================

-- 1. Create Custom Enums
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ar_stage') THEN
        CREATE TYPE ar_stage AS ENUM ('pre_due_3d', 'due_1d', 'overdue_7d', 'overdue_14d', 'overdue_30d', 'settled', 'paused');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ar_channel') THEN
        CREATE TYPE ar_channel AS ENUM ('whatsapp', 'email', 'sms');
    END IF;
END $$;

-- 2. Company AR Collection Policies Table
CREATE TABLE IF NOT EXISTS ar_company_policies (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  is_auto_reminders_enabled BOOLEAN DEFAULT TRUE,
  auto_credit_hold_days INT DEFAULT 30,
  max_early_payment_discount_pct NUMERIC(5,2) DEFAULT 2.00,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. AR Collection Tracking Schedules Table
CREATE TABLE IF NOT EXISTS ar_collection_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES users(id),
  customer_name VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(50),
  customer_email VARCHAR(255),
  invoice_amount NUMERIC(15,2) NOT NULL,
  amount_outstanding NUMERIC(15,2) NOT NULL,
  due_date DATE NOT NULL,
  current_stage ar_stage DEFAULT 'pre_due_3d',
  next_scheduled_reminder TIMESTAMP WITH TIME ZONE,
  is_paused BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT unq_company_invoice_schedule UNIQUE(company_id, invoice_id)
);

-- 4. AR Collection Activity Logs Table
CREATE TABLE IF NOT EXISTS ar_collection_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES ar_collection_schedules(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stage ar_stage NOT NULL,
  channel ar_channel NOT NULL,
  message_body TEXT NOT NULL,
  delivery_status VARCHAR(50) DEFAULT 'sent',
  meta_message_id VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_ar_schedules_company_stage ON ar_collection_schedules(company_id, current_stage);
CREATE INDEX IF NOT EXISTS idx_ar_schedules_next_reminder ON ar_collection_schedules(company_id, next_scheduled_reminder) WHERE is_paused = FALSE;
CREATE INDEX IF NOT EXISTS idx_ar_logs_schedule ON ar_collection_logs(schedule_id);

-- 6. Row-Level Security (RLS) Policies
ALTER TABLE ar_company_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_collection_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_collection_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_ar_policies ON ar_company_policies;
CREATE POLICY tenant_isolation_ar_policies ON ar_company_policies FOR ALL USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_ar_schedules ON ar_collection_schedules;
CREATE POLICY tenant_isolation_ar_schedules ON ar_collection_schedules FOR ALL USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_ar_logs ON ar_collection_logs;
CREATE POLICY tenant_isolation_ar_logs ON ar_collection_logs FOR ALL USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
