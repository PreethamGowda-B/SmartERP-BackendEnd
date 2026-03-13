const { pool } = require('./db');
async function check() {
  try {
    const res = await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_events (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id),
        event_type VARCHAR(50) NOT NULL,
        old_plan_id INTEGER,
        new_plan_id INTEGER,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ subscription_events table checked/created");
  } catch (e) {
    console.error(e);
  } finally {
    process.exit();
  }
}
check();
