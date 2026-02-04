-- Simple employee management schema
-- Employees are stored directly without user accounts

-- Update employee_profiles to work standalone
ALTER TABLE employee_profiles DROP CONSTRAINT IF EXISTS employee_profiles_user_id_fkey;
ALTER TABLE employee_profiles ALTER COLUMN user_id DROP NOT NULL;

-- Add missing columns if they don't exist
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- Create unique index on email
CREATE UNIQUE INDEX IF NOT EXISTS employee_profiles_email_key ON employee_profiles(email) WHERE email IS NOT NULL;
