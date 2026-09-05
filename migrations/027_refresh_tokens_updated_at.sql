-- ============================================================
-- Migration 027: Ensure updated_at column exists on refresh token tables
-- ============================================================

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE customer_refresh_tokens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
