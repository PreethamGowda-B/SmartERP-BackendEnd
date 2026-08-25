-- Migration 024: Secure Account Deletion, Data Erasure & Audit Trail
-- Supports DPDP Act 2023 right to erasure and auditable retention

-- 1. Ensure deletion flags exist on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

-- 2. Ensure deletion flags exist on customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

-- 3. Create immutable account deletion audit log table
CREATE TABLE IF NOT EXISTS account_deletion_audit (
    id SERIAL PRIMARY KEY,
    account_type VARCHAR(50) NOT NULL, -- 'staff' | 'customer'
    original_user_id VARCHAR(255) NOT NULL,
    company_id VARCHAR(255),
    role VARCHAR(50),
    deletion_timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ip_address VARCHAR(100),
    user_agent TEXT,
    reason TEXT,
    retained_records_summary JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_audit_comp ON account_deletion_audit(company_id);
CREATE INDEX IF NOT EXISTS idx_account_deletion_audit_time ON account_deletion_audit(deletion_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_users_is_deleted ON users(is_deleted);
CREATE INDEX IF NOT EXISTS idx_customers_is_deleted ON customers(is_deleted);
