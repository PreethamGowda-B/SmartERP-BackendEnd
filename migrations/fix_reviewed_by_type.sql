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
        -- Alter column to UUID. Resetting to NULL to avoid casting errors if garbage data exists.
        ALTER TABLE material_requests ALTER COLUMN reviewed_by TYPE UUID USING NULL;
    END IF;
END $$;
