// backend/helpers/logActivity.js
const { pool } = require('../../../Downloads/fixed_frontend/back/db');

async function logActivity(userId, action, req = null) {
  try {
    const ip = req?.headers['x-forwarded-for'] || req?.socket?.remoteAddress || null;
    const userAgent = req?.headers['user-agent'] || null;

    await pool.query(
      'INSERT INTO activities (user_id, action, ip_address, user_agent) VALUES ($1, $2, $3, $4)',
      [userId, action, ip, userAgent]
    );
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

module.exports = logActivity;
