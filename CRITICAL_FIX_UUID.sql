-- ============================================================================
-- CRITICAL: Run this EXACT script in Neon SQL Editor
-- This will fix the material_requests table to use UUID (matching users table)
-- ============================================================================

-- Step 1: Check current schema
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'material_requests' 
AND column_name IN ('requested_by', 'reviewed_by')
ORDER BY ordinal_position;

-- Step 2: Drop and recreate with UUID
DROP TABLE IF EXISTS material_requests CASCADE;

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

-- Step 3: Create indexes
CREATE INDEX idx_material_requests_status ON material_requests(status);
CREATE INDEX idx_material_requests_requested_by ON material_requests(requested_by);
CREATE INDEX idx_material_requests_created_at ON material_requests(created_at DESC);

-- Step 4: Verify the fix
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'material_requests' 
AND column_name IN ('requested_by', 'reviewed_by')
ORDER BY ordinal_position;

-- Expected output: Both should show 'uuid'
