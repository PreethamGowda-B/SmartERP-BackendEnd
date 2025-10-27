
const { pool } = require('../db');

async function logActivity(userId, type, details = {}) {
  if (!pool || !pool.query) {
    console.warn("logActivity: DB not ready");
    return;
  }

  try {
    // Safe insert using existing columns only
    await pool.query(
      `INSERT INTO activities (user_id, activity_type, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [userId, type, JSON.stringify(details)]
    );
  } catch (err) {
    console.error("logActivity error:", err);
  }
}

module.exports = logActivity;
