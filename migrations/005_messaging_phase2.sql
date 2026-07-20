-- ============================================================
-- SmartERP Migration 005: Messaging Phase 2
-- Adds message_attachments and message_read_receipts tables.
-- Safe to run multiple times (IF NOT EXISTS guards throughout)
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 1: message_attachments
-- Stores file metadata for messages with attachments.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS message_attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  company_id  INTEGER NOT NULL,
  file_url    TEXT NOT NULL,
  file_name   VARCHAR(255),
  file_type   VARCHAR(100),
  file_size   INTEGER,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_msg_attachments_message
  ON message_attachments(message_id);

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 2: message_read_receipts
-- Tracks 'delivered' and 'read' status per message per user.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS message_read_receipts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  status     VARCHAR(20) CHECK (status IN ('delivered', 'read')),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (message_id, user_id, status)
);

CREATE INDEX IF NOT EXISTS idx_read_receipts_message
  ON message_read_receipts(message_id);

COMMIT;
