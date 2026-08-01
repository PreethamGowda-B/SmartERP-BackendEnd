-- Migration 012: Update company_settings.company_id to VARCHAR(255) to support integer company IDs
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'company_settings' 
          AND column_name = 'company_id' 
          AND data_type = 'uuid'
    ) THEN
        ALTER TABLE company_settings DROP CONSTRAINT IF EXISTS company_settings_company_id_fkey;
        ALTER TABLE company_settings ALTER COLUMN company_id TYPE VARCHAR(255) USING company_id::text;
    END IF;
END $$;
