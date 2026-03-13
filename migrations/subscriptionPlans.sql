-- ============================================================
-- SmartERP — Subscription System Migration
-- Run once on the Neon database via dashboard SQL editor
-- Safe to re-run (all statements use IF NOT EXISTS / ON CONFLICT)
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. Upgrade `plans` table with feature flags and limits
-- ──────────────────────────────────────────────────────────────
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS features            JSONB   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS max_inventory_items INTEGER DEFAULT NULL, -- NULL = unlimited
  ADD COLUMN IF NOT EXISTS max_material_requests INTEGER DEFAULT NULL, -- new limit per tier
  ADD COLUMN IF NOT EXISTS messages_history_days INTEGER DEFAULT 30;

-- ──────────────────────────────────────────────────────────────
-- 2. Upgrade `companies` table for trial + first-login tracking
-- ──────────────────────────────────────────────────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS trial_ends_at           TIMESTAMP,
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS is_on_trial             BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trial_started_at        TIMESTAMP,
  ADD COLUMN IF NOT EXISTS is_first_login          BOOLEAN DEFAULT TRUE;

-- ──────────────────────────────────────────────────────────────
-- 3. Subscription event log (audit trail)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_events (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER   NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_type VARCHAR(60) NOT NULL, -- 'trial_started', 'trial_expired', 'plan_upgraded', 'plan_downgraded'
  old_plan_id INTEGER,
  new_plan_id INTEGER,
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
-- 4. Performance indexes
-- ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_inventory_company  ON inventory_items(company_id);
CREATE INDEX IF NOT EXISTS idx_users_company      ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_messages_created   ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_companies_trial    ON companies(is_on_trial, trial_ends_at) WHERE is_on_trial = TRUE;
CREATE INDEX IF NOT EXISTS idx_sub_events_company ON subscription_events(company_id);

-- ──────────────────────────────────────────────────────────────
-- 5. Seed / Update plan data
--    Using UPSERT so this is safe to re-run
-- ──────────────────────────────────────────────────────────────
INSERT INTO plans
  (id, name, employee_limit, max_inventory_items, max_material_requests, messages_history_days, features, price_monthly, price_yearly)
VALUES
  -- Free Plan
  (1, 'Free', 15, 30, 10, 30,
   '{
     "ai_assistant":      false,
     "location_tracking": false,
     "payroll":           false,
     "inventory_images":  false,
     "basic_reports":     true,
     "advanced_reports":  false,
     "export_reports":    false,
     "messages":          false,
     "priority_support":  false
   }',
   0, 0),

  -- Basic Plan
  (2, 'Basic', 50, 200, 100, 90,
   '{
     "ai_assistant":      false,
     "location_tracking": true,
     "payroll":           true,
     "inventory_images":  true,
     "basic_reports":     true,
     "advanced_reports":  true,
     "export_reports":    true,
     "messages":          true,
     "priority_support":  false
   }',
   999, 9990),

  -- Pro Plan
  (3, 'Pro', NULL, NULL, NULL, 9999,
   '{
     "ai_assistant":      true,
     "location_tracking": true,
     "payroll":           true,
     "inventory_images":  true,
     "basic_reports":     true,
     "advanced_reports":  true,
     "export_reports":    true,
     "messages":          true,
     "priority_support":  true
   }',
   2499, 24990)

ON CONFLICT (id) DO UPDATE
  SET name                  = EXCLUDED.name,
      employee_limit        = EXCLUDED.employee_limit,
      max_inventory_items   = EXCLUDED.max_inventory_items,
      max_material_requests = EXCLUDED.max_material_requests,
      messages_history_days = EXCLUDED.messages_history_days,
      features              = EXCLUDED.features,
      price_monthly         = EXCLUDED.price_monthly,
      price_yearly          = EXCLUDED.price_yearly;
