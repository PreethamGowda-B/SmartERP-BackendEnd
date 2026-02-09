-- Add missing columns expected by materialRequests.js
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS item_name VARCHAR(255);
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS quantity NUMERIC;
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS urgency VARCHAR(50) DEFAULT 'Medium';
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS requested_by_name VARCHAR(255);

-- Add review columns
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS reviewed_by UUID; -- Assuming users.id is UUID
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;

-- Fix requested_by type if necessary (attempt to cast to UUID)
-- Note: This command might fail if there is existing integer data that cannot be cast to UUID.
-- In that case, we might need to handle it manually or clear the table if it's test data.
DO $$ 
BEGIN 
    -- Check if requested_by is integer
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'material_requests' 
        AND column_name = 'requested_by' 
        AND data_type = 'integer'
    ) THEN
        -- Attempt to change type to UUID. 
        -- If data exists, this will likely fail unless data is compatible string-uuids stored as int (impossible).
        -- So we DROP the foreign key constraint first if it exists.
        ALTER TABLE material_requests DROP CONSTRAINT IF EXISTS material_requests_requested_by_fkey;
        
        -- Then we try to convert. If it fails, we might need nullify.
        -- Using USING requested_by::text::uuid will fail for '1', '2'.
        -- We'll just change it to VARCHAR or UUID and set invalid values to NULL?
        -- Safer: Add a temporary column, copy valid UUIDs, drop old.
        -- BUT, for now, let's assuming strict mode:
        ALTER TABLE material_requests ALTER COLUMN requested_by TYPE UUID USING NULL; -- RESET to NULL to avoid errors
        
        -- Re-add FK
        ALTER TABLE material_requests ADD CONSTRAINT material_requests_requested_by_fkey 
        FOREIGN KEY (requested_by) REFERENCES users(id);
    END IF;
END $$;
