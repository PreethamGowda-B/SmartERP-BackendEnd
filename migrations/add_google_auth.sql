-- Add google_id column for OAuth
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;

-- Make password_hash nullable to support Google-only users
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
