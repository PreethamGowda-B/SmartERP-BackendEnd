-- Migration: Fix material_requests table type mismatch
-- Change requested_by and reviewed_by to UUID to match users table

-- Drop the existing table if it exists (WARNING: This will delete all data)
DROP TABLE IF EXISTS material_requests;

-- Recreate with correct types (UUID to match users.id)
CREATE TABLE material_requests (
  id SERIAL PRIMARY KEY,
  item_name VARCHAR(255) NOT NULL,
  quantity INTEGER NOT NULL,
  urgency VARCHAR(50) DEFAULT 'Medium',
  description TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  requested_by UUID NOT NULL,
  requested_by_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  reviewed_by UUID,
  reviewed_at TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX idx_material_requests_status ON material_requests(status);
CREATE INDEX idx_material_requests_requested_by ON material_requests(requested_by);
CREATE INDEX idx_material_requests_created_at ON material_requests(created_at DESC);
