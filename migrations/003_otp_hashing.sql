-- Migration: 003_otp_hashing
-- Adds otp_hash column and migrates away from plaintext OTP storage
-- Run once — safe to re-run (uses IF NOT EXISTS / IF EXISTS guards)

-- Step 1: Add the new hashed column (the app now writes hashes here)
ALTER TABLE email_otps
  ADD COLUMN IF NOT EXISTS otp_hash TEXT;

-- Step 2: Invalidate all existing plaintext OTPs by marking them used
-- (they cannot be migrated since we don't have the original values to re-hash)
UPDATE email_otps
  SET used = TRUE
  WHERE used = FALSE AND otp_hash IS NULL;

-- Step 3: Backfill otp_code with otp_hash value where app has already written hashes
-- (new rows will have otp_hash set by the application)
UPDATE email_otps
  SET otp_hash = otp_code
  WHERE otp_hash IS NULL AND length(otp_code) = 64; -- SHA-256 hex = 64 chars

-- Step 4: The application now reads/writes otp_code column but with SHA-256 hashed values.
-- The column rename is deferred to avoid breaking the existing API.
-- After full deployment, you may rename: ALTER TABLE email_otps RENAME COLUMN otp_code TO otp_hash;

-- Step 5: Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_email_otps_lookup
  ON email_otps(email, otp_code, used, expires_at);
