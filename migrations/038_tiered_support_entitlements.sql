-- Tiered customer support policy and response-time tracking.
-- Repeatable by design; support requests remain in the existing feedback history.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS support_policy JSONB;

UPDATE plans
   SET support_policy = CASE id
     WHEN 1 THEN '{"channels":["email"],"firstResponseBusinessHours":18,"timezone":"Asia/Kolkata","businessDays":[1,2,3,4,5],"businessHours":{"start":"09:00","end":"18:00"}}'::jsonb
     WHEN 2 THEN '{"channels":["email","whatsapp"],"firstResponseBusinessHours":9,"timezone":"Asia/Kolkata","businessDays":[1,2,3,4,5],"businessHours":{"start":"09:00","end":"18:00"}}'::jsonb
     WHEN 3 THEN '{"channels":["email","whatsapp"],"firstResponseBusinessHours":4,"timezone":"Asia/Kolkata","businessDays":[1,2,3,4,5],"businessHours":{"start":"09:00","end":"18:00"}}'::jsonb
   END
 WHERE id IN (1, 2, 3);

-- Keep the legacy boolean as a compatibility signal for existing clients.
UPDATE plans
   SET features = jsonb_set(COALESCE(features, '{}'::jsonb), '{priority_support}', to_jsonb(id IN (2, 3)), TRUE)
 WHERE id IN (1, 2, 3);

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS support_plan_id INTEGER;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS support_channel TEXT;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS support_first_response_business_hours INTEGER;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS support_first_response_due_at TIMESTAMPTZ;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS support_first_responded_at TIMESTAMPTZ;

UPDATE feedback f
   SET company_id = u.company_id::text
  FROM users u
 WHERE f.company_id IS NULL
   AND f.user_id = u.id
   AND u.company_id IS NOT NULL;

-- Preserve the first response timestamp for pre-existing support feedback.
UPDATE feedback
   SET support_first_responded_at = replied_at
 WHERE type = 'support'
   AND replied_at IS NOT NULL
   AND support_first_responded_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'feedback_support_channel_check'
       AND conrelid = 'public.feedback'::regclass
  ) THEN
    ALTER TABLE feedback ADD CONSTRAINT feedback_support_channel_check
      CHECK (support_channel IS NULL OR support_channel IN ('email', 'whatsapp'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'feedback_support_response_hours_check'
       AND conrelid = 'public.feedback'::regclass
  ) THEN
    ALTER TABLE feedback ADD CONSTRAINT feedback_support_response_hours_check
      CHECK (support_first_response_business_hours IS NULL OR support_first_response_business_hours > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_feedback_support_company_created
  ON feedback(company_id, created_at DESC) WHERE type = 'support';
CREATE INDEX IF NOT EXISTS idx_feedback_support_response_due
  ON feedback(support_first_response_due_at) WHERE type = 'support' AND support_first_responded_at IS NULL;
