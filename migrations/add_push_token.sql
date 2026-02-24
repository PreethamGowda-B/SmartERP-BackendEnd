-- Migration: Add push_token to users for Mobile Push Notifications
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT;

-- Create an index for faster lookups when sending notifications
CREATE INDEX IF NOT EXISTS idx_users_push_token ON users(push_token);
