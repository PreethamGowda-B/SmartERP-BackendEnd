const { pool } = require('../db');

async function logActivity(userId, type, req = null) {
  if (!pool || !pool.query) {
    console.warn("logActivity: DB not ready");
    return;
  }

  try {
    // Extract safe fields from request (if available)
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null;
    const userAgent = req?.headers?.['user-agent'] || null;

    const details = {
      ip_address: ip,
      user_agent: userAgent,
      timestamp: new Date().toISOString()
    };

    await pool.query(
      `INSERT INTO activities (user_id, activity_type, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [userId, type, JSON.stringify(details)]
    );
  } catch (err) {
    console.error("logActivity error:", err.message);
  }
}

module.exports = logActivity;
