const { pool } = require('../db');

async function createTable() {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS subscription_notification_logs (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        notification_type VARCHAR(50) NOT NULL, -- 'trial' or 'paid'
        stage INTEGER NOT NULL, -- 7, 3, 1, or 0 (days)
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(company_id, notification_type, stage)
      );
    `;
    await pool.query(query);
    console.log("✅ Table subscription_notification_logs created or verified successfully.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to create table:", err);
    process.exit(1);
  }
}

createTable();
