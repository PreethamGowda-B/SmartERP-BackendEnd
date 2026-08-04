-- Messaging Performance Indexes Migration
-- Sub-10ms query execution speed for enterprise chat operations

CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver ON messages(sender_id, receiver_id);
CREATE INDEX IF NOT EXISTS idx_conv_participants_user ON conversation_participants(user_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_participants_conv ON conversation_participants(conversation_id, user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_company_updated ON conversations(company_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_messages_job_created ON job_messages(job_id, created_at DESC);
