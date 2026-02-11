-- Fix notifications company_id type to INTEGER
DO $$ 
BEGIN 
    -- Check if company_id is NOT integer (e.g. uuid or varchar)
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'notifications' 
        AND column_name = 'company_id' 
        AND data_type != 'integer'
    ) THEN
        -- We drop the column and re-add it as INTEGER. 
        -- Existing UUID data is incompatible with INTEGER logic anyway.
        ALTER TABLE notifications DROP COLUMN company_id;
        ALTER TABLE notifications ADD COLUMN company_id INTEGER;
    END IF;
END $$;
