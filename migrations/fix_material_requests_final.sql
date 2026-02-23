-- ================================================================
-- DEFINITIVE FIX: material_requests table
-- Run this directly in the Neon DB console to fix the 500 error
-- ================================================================

-- Drop the broken table and recreate cleanly
-- (users.id is INTEGER/SERIAL in this database, NOT UUID)

DROP TABLE IF EXISTS material_requests CASCADE;

CREATE TABLE material_requests (
    id SERIAL PRIMARY KEY,
    item_name VARCHAR(255) NOT NULL,
    quantity INTEGER NOT NULL,
    urgency VARCHAR(50) DEFAULT 'Medium',
    description TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    requested_by INTEGER NOT NULL,
    requested_by_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    reviewed_by INTEGER,
    reviewed_at TIMESTAMP
);

CREATE INDEX idx_material_requests_status ON material_requests(status);
CREATE INDEX idx_material_requests_requested_by ON material_requests(requested_by);
CREATE INDEX idx_material_requests_created_at ON material_requests(created_at DESC);

-- Verify the fix
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'material_requests'
ORDER BY ordinal_position;
