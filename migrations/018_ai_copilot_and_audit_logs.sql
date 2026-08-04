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
DO $$ 
BEGIN
    -- Jobs
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='is_ai_created') THEN
        ALTER TABLE jobs ADD COLUMN is_ai_created BOOLEAN DEFAULT FALSE;
        ALTER TABLE jobs ADD COLUMN created_by TEXT;
        ALTER TABLE jobs ADD COLUMN created_through TEXT;
    END IF;

    -- Invoices
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='is_ai_created') THEN
        ALTER TABLE invoices ADD COLUMN is_ai_created BOOLEAN DEFAULT FALSE;
        ALTER TABLE invoices ADD COLUMN created_by TEXT;
        ALTER TABLE invoices ADD COLUMN created_through TEXT;
    END IF;

    -- Leave Requests
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leave_requests' AND column_name='is_ai_created') THEN
        ALTER TABLE leave_requests ADD COLUMN is_ai_created BOOLEAN DEFAULT FALSE;
        ALTER TABLE leave_requests ADD COLUMN created_by TEXT;
        ALTER TABLE leave_requests ADD COLUMN created_through TEXT;
    END IF;

    -- Material Requests
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='material_requests' AND column_name='is_ai_created') THEN
        ALTER TABLE material_requests ADD COLUMN is_ai_created BOOLEAN DEFAULT FALSE;
        ALTER TABLE material_requests ADD COLUMN created_by TEXT;
        ALTER TABLE material_requests ADD COLUMN created_through TEXT;
    END IF;
END $$;
