-- ============================================================
-- Migration 047: Session Inactivity Tracking & Concurrency Hardening
-- Adds last_activity_at and revoked_at to staff and customer refresh token tables.
-- Supports rolling 7-day inactivity expiration and rotation grace period.
-- ============================================================

-- 1. Refresh tokens (Staff & Admin)
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP WITH TIME ZONE;

-- Backfill last_activity_at for existing records
UPDATE refresh_tokens
SET last_activity_at = COALESCE(updated_at, created_at, NOW())
WHERE last_activity_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_last_activity ON refresh_tokens(user_id, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_family ON refresh_tokens(token_family);

-- 2. Customer refresh tokens (Customer Portal)
ALTER TABLE customer_refresh_tokens ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE customer_refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP WITH TIME ZONE;

-- Backfill last_activity_at for existing customer records
UPDATE customer_refresh_tokens
SET last_activity_at = COALESCE(updated_at, created_at, NOW())
WHERE last_activity_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_crt_last_activity ON customer_refresh_tokens(customer_id, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_crt_token_family ON customer_refresh_tokens(token_family);
