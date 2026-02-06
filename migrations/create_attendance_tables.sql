-- Migration: Create attendance management tables
-- This creates tables for tracking employee attendance and correction requests

-- ─── ATTENDANCE TABLE ────────────────────────────────────────────────────────
DROP TABLE IF EXISTS attendance CASCADE;

CREATE TABLE attendance (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  company_id UUID NOT NULL,
  date DATE NOT NULL,
  check_in_time TIMESTAMP,
  check_out_time TIMESTAMP,
  working_hours DECIMAL(5,2), -- Auto-calculated in hours (e.g., 8.50)
  status VARCHAR(20) DEFAULT 'present', -- 'present', 'absent', 'half_day', 'late'
  is_late BOOLEAN DEFAULT FALSE,
  notes TEXT,
  is_manual BOOLEAN DEFAULT FALSE, -- Manually edited by owner
  edited_by UUID, -- Owner who edited
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_user_date UNIQUE(user_id, date) -- One record per employee per day
);

-- Create indexes for better query performance
CREATE INDEX idx_attendance_user_date ON attendance(user_id, date DESC);
CREATE INDEX idx_attendance_company ON attendance(company_id);
CREATE INDEX idx_attendance_date ON attendance(date DESC);
CREATE INDEX idx_attendance_status ON attendance(status);
CREATE INDEX idx_attendance_user_month ON attendance(user_id, EXTRACT(YEAR FROM date), EXTRACT(MONTH FROM date));

-- ─── ATTENDANCE CORRECTIONS TABLE ────────────────────────────────────────────
DROP TABLE IF EXISTS attendance_corrections CASCADE;

CREATE TABLE attendance_corrections (
  id SERIAL PRIMARY KEY,
  attendance_id INTEGER REFERENCES attendance(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  requested_check_in TIMESTAMP,
  requested_check_out TIMESTAMP,
  reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  reviewed_by UUID,
  reviewed_at TIMESTAMP,
  rejection_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for corrections
CREATE INDEX idx_corrections_attendance ON attendance_corrections(attendance_id);
CREATE INDEX idx_corrections_user ON attendance_corrections(user_id);
CREATE INDEX idx_corrections_status ON attendance_corrections(status);

-- Add comment for documentation
COMMENT ON TABLE attendance IS 'Stores daily attendance records for employees';
COMMENT ON TABLE attendance_corrections IS 'Stores employee requests to correct their attendance records';
