-- SmartERP Migration 013: Enhanced Feedback Table Columns
-- Additive migration — safe to run on existing data, all columns use IF NOT EXISTS

ALTER TABLE feedback 
  ADD COLUMN IF NOT EXISTS portal VARCHAR(50),
  ADD COLUMN IF NOT EXISTS module VARCHAR(100),
  ADD COLUMN IF NOT EXISTS page_path VARCHAR(500),
  ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS browser VARCHAR(200),
  ADD COLUMN IF NOT EXISTS device VARCHAR(200);

-- Update default status for existing rows that have null status
UPDATE feedback SET status = 'new' WHERE status IS NULL;

-- Create index on status for dashboard queries
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(type);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);
