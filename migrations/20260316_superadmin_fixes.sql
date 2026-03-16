-- ==========================================
-- Superadmin Fixes & Performance Optimization
-- 2026-03-16
-- ==========================================

-- 1. Add status column to companies for activation/suspension
ALTER TABLE companies ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';

-- 2. Performance Indexes for Superadmin Dashboard & Analytics
CREATE INDEX IF NOT EXISTS idx_activities_created_at ON activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_companies_created_at ON companies(created_at DESC);

-- 3. Ensure activity_type exists (from server.js initialization)
-- This is just a safeguard
ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_type TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS details JSONB;
