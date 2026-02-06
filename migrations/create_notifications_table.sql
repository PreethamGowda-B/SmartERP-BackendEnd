-- Migration: Create notifications table for real-time notification system
-- This table stores all notifications for employees

DROP TABLE IF EXISTS notifications;

CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  company_id UUID NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'job', 'material_request', 'payroll', 'message'
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  read BOOLEAN DEFAULT FALSE,
  priority VARCHAR(20) DEFAULT 'medium', -- 'low', 'medium', 'high'
  data JSONB, -- Additional metadata (job_id, request_id, etc.)
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_company_id ON notifications(company_id);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX idx_notifications_read ON notifications(read);
CREATE INDEX idx_notifications_type ON notifications(type);

-- Composite index for common query pattern
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, read, created_at DESC);
