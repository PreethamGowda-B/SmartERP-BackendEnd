-- Add attendance columns to payroll table
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS present_days INTEGER DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS absent_days INTEGER DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS half_days INTEGER DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS total_working_hours DECIMAL(6,2) DEFAULT 0;

-- Add comment
COMMENT ON COLUMN payroll.present_days IS 'Number of days employee was present';
COMMENT ON COLUMN payroll.absent_days IS 'Number of days employee was absent';
COMMENT ON COLUMN payroll.half_days IS 'Number of half days';
COMMENT ON COLUMN payroll.total_working_hours IS 'Total working hours for the month';
