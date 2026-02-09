-- Fix reviewed_by type to UUID
DO $$ 
BEGIN 
    -- Check if reviewed_by is integer
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'material_requests' 
        AND column_name = 'reviewed_by' 
        AND data_type = 'integer'
    ) THEN
        -- Drop any potential FK (though unlikely to exist if it was just added as int)
        ALTER TABLE material_requests DROP CONSTRAINT IF EXISTS material_requests_reviewed_by_fkey;
        
        -- Change type to UUID, resetting invalid data to NULL
        ALTER TABLE material_requests ALTER COLUMN reviewed_by TYPE UUID USING NULL; 
        
        -- Add FK constraint
        ALTER TABLE material_requests ADD CONSTRAINT material_requests_reviewed_by_fkey 
        FOREIGN KEY (reviewed_by) REFERENCES users(id);
    END IF;
END $$;
