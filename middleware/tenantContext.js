/**
 * middleware/tenantContext.js
 * Ensures Row-Level Security (RLS) is active for the current request.
 */
const { storage } = require('./als');

function setTenantContext(req, res, next) {
  const companyId = req.user?.companyId;
  
  if (!companyId) return next();

  // Run the rest of the request chain inside the ALS context
  storage.run({ companyId }, () => {
    next();
  });
}

module.exports = { setTenantContext };
