-- Customer notification read state is stored on the existing activity row.
-- Additive and safe to run repeatedly; no historical activity data is changed.
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS customer_read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customer_notification_feed_scope
  ON activities (company_id, created_at DESC)
  WHERE activity_type = 'customer_notification';
