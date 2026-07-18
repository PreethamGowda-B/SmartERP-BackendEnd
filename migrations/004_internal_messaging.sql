-- ============================================================
-- SmartERP Migration 004: Internal Messaging System
-- Introduces conversations, conversation_participants tables
-- and extends the existing messages table for real-time chat.
-- Safe to run multiple times (IF NOT EXISTS guards throughout)
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 1: conversations table
-- Groups messages between two or more users within a company.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 2: conversation_participants table
-- Tracks which users belong to each conversation and their read state.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_participants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  joined_at       TIMESTAMP DEFAULT NOW(),
  last_read_at    TIMESTAMP DEFAULT NULL,
  UNIQUE (conversation_id, user_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 3: Extend existing messages table
-- Adds conversation_id, content, and message_type columns.
-- All additions are guarded with IF NOT EXISTS so backfills remain separate.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS content TEXT;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'text';

-- Add the CHECK constraint on message_type only if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_message_type_check'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_message_type_check
        CHECK (message_type IN ('text', 'image', 'document'));
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 4: Indexes
-- ────────────────────────────────────────────────────────────────────────────

-- Optimises paginated message fetching within a conversation
CREATE INDEX IF NOT EXISTS idx_messages_conv_created
  ON messages(conversation_id, created_at);

-- Optimises company-scoped message queries (multi-tenant isolation)
CREATE INDEX IF NOT EXISTS idx_messages_company
  ON messages(company_id);

-- Optimises looking up all conversations a user participates in
CREATE INDEX IF NOT EXISTS idx_conv_participants_user
  ON conversation_participants(user_id);

-- Optimises listing all conversations for a company
CREATE INDEX IF NOT EXISTS idx_conversations_company
  ON conversations(company_id);

COMMIT;
