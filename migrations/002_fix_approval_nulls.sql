-- Fix Approval State Reset Bug: Normalize NULL values
-- This migration fixes the root cause of the UI showing jobs reverting to "Pending Review" 
-- by ensuring all legacy jobs have a proper explicit approval_status string, rather
-- than relying on frontend or backend COALESCE fallbacks.

BEGIN;

-- 1. Identify jobs that have NULL approval_status and safely update them to 'pending_approval'
-- Note: 'pending_approval' is the hardened status we just normalized the backend to expect.
UPDATE jobs
SET approval_status = 'pending_approval'
WHERE approval_status IS NULL AND source = 'customer';

-- 2. Verify check constraints to prevent future NULLs if possible
-- We won't alter column nullability directly unless sure, but the backend is now
-- strictly written to insert 'pending_approval' and error if it encounters bad states.
-- We add a standard check constraint for safety if one doesn't exist:
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'jobs_approval_status_check'
    ) THEN
        ALTER TABLE jobs
        ADD CONSTRAINT jobs_approval_status_check 
        CHECK (approval_status IN ('pending_approval', 'approved', 'rejected'));
    END IF;
END $$;

COMMIT;
