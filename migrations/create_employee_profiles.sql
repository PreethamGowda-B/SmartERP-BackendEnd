-- Migration: Create employee_profiles table
-- Run this when Neon is back online

-- Create the employee_profiles table
CREATE TABLE IF NOT EXISTS employee_profiles (
  id SERIAL PRIMARY KEY,
  user_id UUID,
  name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  position VARCHAR(100),
  department VARCHAR(100),
  hire_date TIMESTAMP,
  is_active BOOLEAN,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_employee_profiles_user_id ON employee_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_profiles_email ON employee_profiles(email);

-- Populate with existing users who have role='user'
INSERT INTO employee_profiles (user_id, name, email, phone, position, department, hire_date, is_active, created_at, updated_at)
SELECT 
  id, 
  name, 
  email, 
  phone, 
  position, 
  department, 
  created_at, 
  true, 
  created_at, 
  created_at
FROM users
WHERE role = 'user'
ON CONFLICT DO NOTHING;
