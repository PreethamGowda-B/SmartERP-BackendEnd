-- Enterprise Communication Backbone Schema Migration
-- Enhances conversations and messages tables to support job chats, department channels, ERP cards, voice notes, & media

ALTER TABLE conversations 
  ADD COLUMN IF NOT EXISTS conversation_type TEXT DEFAULT 'direct', -- 'direct', 'job', 'department', 'announcement'
  ADD COLUMN IF NOT EXISTS department_key TEXT, -- 'hr', 'finance', 'inventory', 'operations'
  ADD COLUMN IF NOT EXISTS job_id TEXT;

ALTER TABLE messages 
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'text', -- 'text', 'image', 'video', 'audio', 'document', 'erp_card'
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS file_size INT,
  ADD COLUMN IF NOT EXISTS duration INT,
  ADD COLUMN IF NOT EXISTS erp_record_type TEXT, -- 'job', 'invoice', 'leave', 'payslip', 'asset'
  ADD COLUMN IF NOT EXISTS erp_record_id TEXT,
  ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reply_to_id INT;

CREATE TABLE IF NOT EXISTS chat_reactions (
    id SERIAL PRIMARY KEY,
    message_id INT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT,
    emoji TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS pinned_conversations (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    conversation_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, conversation_id)
);
