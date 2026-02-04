-- Migration: Add missing columns to users table
-- This fixes the 500 error when creating employees

-- Add name column if it doesn't exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);

-- Add phone column if it doesn't exist (used in auth.js signup)
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);

-- Add position column if it doesn't exist (used in auth.js signup)
ALTER TABLE users ADD COLUMN IF NOT EXISTS position VARCHAR(100);

-- Add department column if it doesn't exist (used in auth.js signup)
ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(100);
