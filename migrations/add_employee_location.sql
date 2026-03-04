-- Migration: Add real-time location tracking columns to employee_profiles
-- These are added with IF NOT EXISTS so this is safe to run multiple times.

ALTER TABLE employee_profiles
  ADD COLUMN IF NOT EXISTS latitude         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

-- Index for fast owner lookups of recently-updated locations
CREATE INDEX IF NOT EXISTS idx_employee_profiles_location_updated_at
  ON employee_profiles (location_updated_at DESC NULLS LAST);
