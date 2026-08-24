-- Migration 018: AI Copilot Audit Logs & AI Creation Metadata

-- 1. Create AI Audit Logs Table
CREATE TABLE IF NOT EXISTS ai_audit_logs (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_name TEXT,
    role TEXT NOT NULL,
    company_id INT,
    prompt TEXT NOT NULL,
    action_name TEXT NOT NULL,
    affected_record_id TEXT,
    status TEXT DEFAULT 'SUCCESS',
    details JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 2. Add AI creation metadata columns to core tables safely
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_ai_created BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS created_through TEXT;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_ai_created BOOLEAN DEFAULT FALSE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_through TEXT;

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS is_ai_created BOOLEAN DEFAULT FALSE;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS created_through TEXT;

ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS is_ai_created BOOLEAN DEFAULT FALSE;
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS created_through TEXT;
