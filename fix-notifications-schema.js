const { pool } = require('./db');

async function fixNotificationsSchema() {
  const client = await pool.connect();
  try {
    console.log('🚀 Fixing notifications table schema...\n');

    // Add missing columns to notifications table
    console.log('📋 Adding "type", "priority", and "data" columns to notifications...');
    await client.query(`
      ALTER TABLE notifications 
      ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'info',
      ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium',
      ADD COLUMN IF NOT EXISTS data JSONB
    `);
    
    console.log('✅ notifications table updated successfully!');

    // Verify
    const cols = await client.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications'
    `);
    console.log('Current notifications columns:', cols.rows.map(r => r.column_name).join(', '));

  } catch (err) {
    console.error('❌ Schema fix failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

fixNotificationsSchema();
