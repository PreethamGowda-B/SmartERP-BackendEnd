-- ============================================================
-- Migration: Add company_id to jobs table
-- Run this once against your production database.
-- Safe to run multiple times (uses IF NOT EXISTS).
-- ============================================================

-- Step 1: Add company_id column to jobs table
-- We use TEXT to match the UUID string format used by req.user.companyId
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS company_id TEXT;

-- Step 2: Backfill existing jobs with the company_id from the job creator
-- This links each existing job to the owner who created it.
UPDATE jobs j
SET company_id = u.company_id::TEXT
FROM users u
WHERE j.created_by = u.id
  AND j.company_id IS NULL;

-- Step 3: Add an index for fast company-scoped queries
CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id);

-- Step 4: Verify
DO $$
DECLARE
  total_jobs       INTEGER;
  jobs_with_company INTEGER;
BEGIN
  SELECT COUNT(*)              INTO total_jobs        FROM jobs;
  SELECT COUNT(*)              INTO jobs_with_company FROM jobs WHERE company_id IS NOT NULL;

  RAISE NOTICE '=== Migration: add_company_id_to_jobs ===';
  RAISE NOTICE 'Total jobs:             %', total_jobs;
  RAISE NOTICE 'Jobs with company_id:   %', jobs_with_company;
  RAISE NOTICE 'Jobs WITHOUT company:   %', (total_jobs - jobs_with_company);
  RAISE NOTICE '=========================================';
END $$;
