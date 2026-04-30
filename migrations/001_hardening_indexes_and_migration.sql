-- ============================================================
-- SmartERP Phase 1: Database Hardening — Indexes, Constraints & Data Migration
-- Run manually on staging first, then production
-- Safe to run multiple times (IF NOT EXISTS guards throughout)
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 1: Performance Indexes
-- ────────────────────────────────────────────────────────────────────────────

-- jobs table indexes
CREATE INDEX IF NOT EXISTS idx_jobs_company_id         ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_assigned_to        ON jobs(assigned_to);
CREATE INDEX IF NOT EXISTS idx_jobs_employee_status    ON jobs(employee_status);
CREATE INDEX IF NOT EXISTS idx_jobs_approval_status    ON jobs(approval_status);
CREATE INDEX IF NOT EXISTS idx_jobs_status             ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_customer_id        ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_source             ON jobs(source);
-- Composite: what employees query most often
CREATE INDEX IF NOT EXISTS idx_jobs_emp_visibility
  ON jobs(company_id, assigned_to, employee_status, status);

-- messages / job_messages indexes
CREATE INDEX IF NOT EXISTS idx_messages_sender_id      ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver_id    ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_company_id     ON messages(company_id) WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_messages_job_id     ON job_messages(job_id);
CREATE INDEX IF NOT EXISTS idx_job_messages_company_id ON job_messages(company_id);
CREATE INDEX IF NOT EXISTS idx_job_messages_created_at ON job_messages(created_at DESC);

-- notifications indexes
CREATE INDEX IF NOT EXISTS idx_notifications_user_id   ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_company   ON notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read      ON notifications(user_id, is_read);

-- attendance indexes
CREATE INDEX IF NOT EXISTS idx_attendance_user_id      ON attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_company_id   ON attendance(company_id);

-- employee_profiles
CREATE INDEX IF NOT EXISTS idx_employee_profiles_user  ON employee_profiles(user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 2: Review System Constraint
-- ────────────────────────────────────────────────────────────────────────────

-- Ensure the job_reviews table exists (safe CREATE IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS job_reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL,
  customer_id UUID NOT NULL,
  employee_id UUID,
  company_id  TEXT,
  rating      SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Add unique constraint to prevent duplicate reviews (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniq_job_reviews_job_customer'
  ) THEN
    ALTER TABLE job_reviews
      ADD CONSTRAINT uniq_job_reviews_job_customer UNIQUE (job_id, customer_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_job_reviews_job_id      ON job_reviews(job_id);
CREATE INDEX IF NOT EXISTS idx_job_reviews_employee_id ON job_reviews(employee_id);
CREATE INDEX IF NOT EXISTS idx_job_reviews_customer_id ON job_reviews(customer_id);

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 3: Add review_status column to jobs (if missing)
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'jobs' AND column_name = 'review_status'
  ) THEN
    ALTER TABLE jobs ADD COLUMN review_status TEXT DEFAULT NULL;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 4: Add company_id to messages table (if missing)
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'company_id'
  ) THEN
    ALTER TABLE messages ADD COLUMN company_id TEXT;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 5: Data Migration — Normalize Legacy broken states
-- ────────────────────────────────────────────────────────────────────────────

-- 5A: Jobs with NULL approval_status that have source='customer' -> set to 'pending_approval'
-- (only for jobs that are truly unprocessed: status='open', no assigned_to, no accepted_at)
UPDATE jobs
SET approval_status = 'pending_approval'
WHERE
  source = 'customer'
  AND approval_status IS NULL
  AND assigned_to IS NULL
  AND accepted_at IS NULL
  AND status = 'open';

-- 5B: Jobs with NULL approval_status that have source='customer' and are completed/assigned -> set to 'approved'
UPDATE jobs
SET approval_status = 'approved'
WHERE
  source = 'customer'
  AND approval_status IS NULL
  AND (status = 'completed' OR status = 'in_progress' OR status = 'active' OR assigned_to IS NOT NULL);

-- 5C: Non-customer jobs with NULL approval_status -> set to 'approved' (these bypass the approval flow)
UPDATE jobs
SET approval_status = 'approved'
WHERE
  (source != 'customer' OR source IS NULL)
  AND approval_status IS NULL;

-- 5D: Fix status inconsistency: if employee_status = 'completed' but status != 'completed', fix status
UPDATE jobs
SET status = 'completed',
    completed_at = COALESCE(completed_at, NOW())
WHERE
  employee_status = 'completed'
  AND status NOT IN ('completed', 'cancelled');

-- 5E: 'active' is an alias used in old code — normalize to 'in_progress'
UPDATE jobs
SET status = 'in_progress'
WHERE status = 'active';

-- 5F: Jobs that are 'in_progress' but have no employee_status set — fix to 'accepted'
UPDATE jobs
SET employee_status = 'accepted'
WHERE
  status = 'in_progress'
  AND employee_status IS NULL
  AND assigned_to IS NOT NULL;

-- 5G: Set review_status = 'submitted' for jobs that already have a review in job_reviews
UPDATE jobs j
SET review_status = 'submitted'
WHERE EXISTS (
  SELECT 1 FROM job_reviews r WHERE r.job_id = j.id
)
AND (j.review_status IS NULL OR j.review_status != 'submitted');

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 6: Notification Deduplication Support
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notifications' AND column_name = 'idempotency_key'
  ) THEN
    ALTER TABLE notifications ADD COLUMN idempotency_key TEXT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency
  ON notifications(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 7: Validate — Show summary of normalized records
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  null_approvals   INT;
  broken_statuses  INT;
  pending_reviews  INT;
BEGIN
  SELECT COUNT(*) INTO null_approvals  FROM jobs WHERE approval_status IS NULL;
  SELECT COUNT(*) INTO broken_statuses FROM jobs WHERE status = 'active';
  SELECT COUNT(*) INTO pending_reviews
    FROM jobs j
    WHERE j.status = 'completed'
      AND j.review_status IS NULL
      AND NOT EXISTS (SELECT 1 FROM job_reviews r WHERE r.job_id = j.id);
  RAISE NOTICE 'Migration complete. Remaining NULL approval_status: %, Remaining active (not in_progress): %, Jobs completed but pending review: %',
    null_approvals, broken_statuses, pending_reviews;
END $$;

COMMIT;
