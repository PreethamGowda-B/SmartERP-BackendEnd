const { pool } = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Add missing columns to refresh_tokens
    // Using DO blocks for idempotency if some columns already exist
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='refresh_tokens' AND column_name='token_family') THEN
          ALTER TABLE refresh_tokens ADD COLUMN token_family UUID;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='refresh_tokens' AND column_name='revoked') THEN
          ALTER TABLE refresh_tokens ADD COLUMN revoked BOOLEAN DEFAULT FALSE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='refresh_tokens' AND column_name='created_at') THEN
          ALTER TABLE refresh_tokens ADD COLUMN created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='refresh_tokens' AND column_name='user_agent') THEN
          ALTER TABLE refresh_tokens ADD COLUMN user_agent TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='refresh_tokens' AND column_name='ip_address') THEN
          ALTER TABLE refresh_tokens ADD COLUMN ip_address TEXT;
        END IF;
      END $$;
    `);

    // 2. Add indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(token_family)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at)`);

    await client.query('COMMIT');
    console.log('✅ Migration successful: refresh_tokens table updated with security fields.');
    process.exit(0);
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    if (client) client.release();
  }
}

migrate();
