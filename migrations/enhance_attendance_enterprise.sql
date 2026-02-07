-- Enterprise Attendance System - Schema Enhancements
-- Phase 1: Add shift-based columns and processing flags

-- Add shift-related columns to attendance table
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS shift_start TIME DEFAULT '09:00:00';
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS shift_end TIME DEFAULT '19:00:00';
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS is_auto_clocked_out BOOLEAN DEFAULT FALSE;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS biometric_device_id VARCHAR(100);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_in_method VARCHAR(20) DEFAULT 'manual';
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_out_method VARCHAR(20) DEFAULT 'manual';
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS is_processed BOOLEAN DEFAULT FALSE;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP;

-- Add index for daily processing queries
CREATE INDEX IF NOT EXISTS idx_attendance_processing ON attendance(date, is_processed);
CREATE INDEX IF NOT EXISTS idx_attendance_date_user ON attendance(date, user_id);

-- Add comments for documentation
COMMENT ON COLUMN attendance.shift_start IS 'Shift start time (default 9:00 AM)';
COMMENT ON COLUMN attendance.shift_end IS 'Shift end time (default 7:00 PM)';
COMMENT ON COLUMN attendance.is_auto_clocked_out IS 'True if system auto-clocked out at shift end';
COMMENT ON COLUMN attendance.biometric_device_id IS 'ID of biometric device used (if applicable)';
COMMENT ON COLUMN attendance.clock_in_method IS 'Method used: manual or biometric';
COMMENT ON COLUMN attendance.clock_out_method IS 'Method used: manual or biometric';
COMMENT ON COLUMN attendance.is_processed IS 'True if daily processing completed for this record';
COMMENT ON COLUMN attendance.processed_at IS 'Timestamp when daily processing was completed';

-- Create biometric_devices table (optional, for future use)
CREATE TABLE IF NOT EXISTS biometric_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(100) UNIQUE NOT NULL,
    device_name VARCHAR(255),
    device_type VARCHAR(50), -- 'fingerprint', 'face_scanner'
    company_id UUID,
    location VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    last_sync TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_biometric_devices_company ON biometric_devices(company_id);
CREATE INDEX IF NOT EXISTS idx_biometric_devices_active ON biometric_devices(is_active);

COMMENT ON TABLE biometric_devices IS 'Registered biometric devices for attendance tracking';
