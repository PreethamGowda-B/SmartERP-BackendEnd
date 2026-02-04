-- Migration: Create inventory_items table for employee inventory management
-- Run this in Neon SQL Editor when the database is accessible

CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  quantity INTEGER DEFAULT 0,
  image_url TEXT,
  created_by UUID,
  employee_name VARCHAR(255),
  office_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_inventory_items_created_by ON inventory_items(created_by);
CREATE INDEX IF NOT EXISTS idx_inventory_items_created_at ON inventory_items(created_at);
