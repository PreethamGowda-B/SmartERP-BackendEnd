-- ============================================================================
-- Migration 026: Complete Password Reset & Recovery System
-- Single-use cryptographically secure reset authorization tokens and account-type segregation
-- ============================================================================

-- 1. Add account_type to email_otps table
ALTER TABLE email_otps 
    ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) DEFAULT 'staff',
    ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_email_otps_acc_lookup 
    ON email_otps(email, account_type, used, expires_at);

-- 2. Password Reset Authorization Tokens Table
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_type VARCHAR(20) NOT NULL DEFAULT 'staff', -- 'staff' | 'customer'
    user_id UUID NOT NULL,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    ip_address VARCHAR(50),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pw_reset_token_lookup 
    ON password_reset_tokens(token_hash, used, expires_at);

CREATE INDEX IF NOT EXISTS idx_pw_reset_user_lookup 
    ON password_reset_tokens(user_id, account_type, created_at DESC);
