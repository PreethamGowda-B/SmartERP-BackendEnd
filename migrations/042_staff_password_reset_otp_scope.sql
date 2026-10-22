-- SmartERP 042: support purpose-bound, HMAC-protected staff password reset OTPs.
-- This migration widens otp_code without changing its stored values, then adds
-- an explicit purpose marker. Existing rows remain email_verification by default
-- and cannot be consumed by the password-recovery verifier.

DO $$
DECLARE
  current_type TEXT;
BEGIN
  SELECT data_type
    INTO current_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'email_otps'
     AND column_name = 'otp_code';

  IF current_type IS NULL THEN
    RAISE EXCEPTION 'email_otps.otp_code is required before migration 042';
  ELSIF current_type <> 'text' THEN
    ALTER TABLE public.email_otps
      ALTER COLUMN otp_code TYPE TEXT USING otp_code::text;
  END IF;
END $$;

ALTER TABLE public.email_otps
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(32) NOT NULL DEFAULT 'email_verification';

CREATE INDEX IF NOT EXISTS idx_email_otps_staff_purpose_lookup
  ON public.email_otps (LOWER(email), account_type, purpose, expires_at)
  WHERE used = FALSE;
