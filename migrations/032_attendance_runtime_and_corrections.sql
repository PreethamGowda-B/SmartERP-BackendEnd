-- ==============================================================================
-- SmartERP Migration 032: Attendance Runtime Fields and Corrections Table
-- ==============================================================================
-- Forward-only, additive migration.
-- Establishes runtime attendance columns and attendance_corrections table.
-- ==============================================================================

BEGIN;

-- 1. Ensure attendance runtime columns exist
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS check_in_time TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS check_out_time TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS is_late BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS edited_by UUID,
  ADD COLUMN IF NOT EXISTS clock_in_method VARCHAR(50) DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS clock_out_method VARCHAR(50) DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS is_auto_clocked_out BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_processed BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS biometric_device_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS shift_start TIME DEFAULT '09:00:00',
  ADD COLUMN IF NOT EXISTS shift_end TIME DEFAULT '19:00:00',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 2. Backfill check_in_time / check_out_time from legacy clock_in / clock_out if present
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'attendance' AND column_name = 'clock_in'
    ) THEN
        UPDATE attendance
           SET check_in_time = clock_in
         WHERE check_in_time IS NULL AND clock_in IS NOT NULL;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'attendance' AND column_name = 'clock_out'
    ) THEN
        UPDATE attendance
           SET check_out_time = clock_out
         WHERE check_out_time IS NULL AND clock_out IS NOT NULL;
    END IF;
END $$;

-- 3. Core indexes for attendance queries
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance(user_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_company_date ON attendance(company_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_company_processed ON attendance(company_id, is_processed);

-- 4. Create attendance_corrections table
CREATE TABLE IF NOT EXISTS attendance_corrections (
  id                  SERIAL PRIMARY KEY,
  attendance_id       UUID,
  user_id             UUID,
  requested_check_in  TIMESTAMP WITH TIME ZONE NOT NULL,
  requested_check_out TIMESTAMP WITH TIME ZONE,
  reason              TEXT,
  status              VARCHAR(50) DEFAULT 'pending',
  reviewed_by         UUID,
  reviewed_at         TIMESTAMP WITH TIME ZONE,
  rejection_reason    TEXT,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Indexes for attendance_corrections queries
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_att_id ON attendance_corrections(attendance_id);
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_user_id ON attendance_corrections(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_status ON attendance_corrections(status);

COMMIT;
