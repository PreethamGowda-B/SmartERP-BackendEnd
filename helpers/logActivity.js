const { pool } = require('../db');

async function logActivity(userId, action, req = null, companyId = null) {
  if (!pool || !pool.query) {
    console.warn("logActivity: DB not ready");
    return;
  }

  try {
    // Extract safe fields from request (if available)
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null;
    const userAgent = req?.headers?.['user-agent'] || null;

    // If companyId not provided but req.user exists, try to get it from there
    const finalCompanyId = companyId || req?.user?.companyId || null;

    await pool.query(
      `INSERT INTO activities (user_id, action, ip_address, user_agent, company_id, timestamp)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, action, ip, userAgent, finalCompanyId]
    );
  } catch (err) {
    console.error("logActivity error:", err.message);
  }
}

module.exports = logActivity;
