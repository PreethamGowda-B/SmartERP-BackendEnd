/**
 * middleware/tenantContext.js
 * Ensures Row-Level Security (RLS) is active for the current request.
 */
const { pool } = require('../db');

async function setTenantContext(req, res, next) {
  if (!req.user || !req.user.companyId) return next();

  try {
    // We attach a 'db' object to the request that is a single client with the tenant set
    const client = await pool.connect();
    
    // Set the local session variable for RLS
    await client.query(`SET LOCAL app.current_company_id = '${req.user.companyId}'`);
    
    // Attach the client to the request
    req.db = client;

    // Ensure we release the client when the request is done
    const originalEnd = res.end;
    res.end = function(...args) {
      client.release();
      originalEnd.apply(res, args);
    };

    next();
  } catch (err) {
    console.error('Failed to set tenant context:', err.message);
    res.status(500).json({ message: 'Database connection error' });
  }
}

module.exports = { setTenantContext };
