-- Fix attendance and biometric_devices company_id type mismatch
-- This script handles dependent indexes and multiple possible RLS policy names
DO $$ 
BEGIN 
    -- 1. Handle attendance table
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'attendance' AND column_name = 'company_id' AND data_type != 'integer'
    ) THEN
        -- Drop ALL potential dependent objects
        -- Drop both names we've seen in logs or suspected
        DROP POLICY IF EXISTS attendance_isolation ON attendance;
        DROP POLICY IF EXISTS attendance_isolation_policy ON attendance;
        DROP POLICY IF EXISTS attendance_policy ON attendance;
        
        DROP INDEX IF EXISTS idx_attendance_company;
        DROP INDEX IF EXISTS idx_attendance_company_id;
        
        -- Convert column to INTEGER
        ALTER TABLE attendance 
        ALTER COLUMN company_id TYPE INTEGER 
        USING (CASE WHEN company_id::text ~ '^[0-9]+$' THEN company_id::text::integer ELSE 1 END);
        
        -- Re-create index
        CREATE INDEX IF NOT EXISTS idx_attendance_company_id ON attendance(company_id);
        
        -- Re-create RLS Policy (standard name)
        CREATE POLICY attendance_isolation ON attendance 
        FOR ALL 
        USING (company_id = current_setting('app.current_company_id', true)::integer);
    END IF;

    -- 2. Handle biometric_devices table
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'biometric_devices' AND column_name = 'company_id' AND data_type != 'integer'
    ) THEN
        -- Drop ALL dependent objects
        DROP POLICY IF EXISTS biometric_devices_isolation ON biometric_devices;
        
        DROP INDEX IF EXISTS idx_biometric_devices_company;
        DROP INDEX IF EXISTS idx_biometric_devices_company_id;
        
        -- Convert column to INTEGER
        ALTER TABLE biometric_devices 
        ALTER COLUMN company_id TYPE INTEGER 
        USING (CASE WHEN company_id::text ~ '^[0-9]+$' THEN company_id::text::integer ELSE 1 END);
        
        -- Re-create index
        CREATE INDEX IF NOT EXISTS idx_biometric_devices_company_id ON biometric_devices(company_id);
        
        -- Re-create RLS Policy if it's a multi-tenant system
        CREATE POLICY biometric_devices_isolation ON biometric_devices 
        FOR ALL 
        USING (company_id = current_setting('app.current_company_id', true)::integer);
    END IF;
    
    RAISE NOTICE 'Company ID types fixed in attendance and biometric_devices tables';
END $$;
