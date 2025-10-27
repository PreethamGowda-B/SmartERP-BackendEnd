// back/helpers/logActivity.js
const { pool } = require('../db');

/**
 * logActivity - insert an activity record into activities table (safe)
 * Params:
 *   userId: string or number
 *   type: string
 *   details: object or string
 */
async function logActivity(userId, type, details = null) {
  if (!pool) {
    console.error('logActivity: DB pool is undefined, skipping log', { userId, type });
    return;
  }

  try {
    const detailsText =
      details && typeof details === 'object' ? JSON.stringify(details) : details;

    const sql = `
      INSERT INTO activities (user_id, type, details, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING id;
    `;
    const values = [userId, type, detailsText];
    await pool.query(sql, values);
  } catch (err) {
    console.error('logActivity error:', err);
  }
}

module.exports = logActivity;
