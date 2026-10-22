'use strict';

// Tenant financial summaries and invoice records are restricted to company
// owners and administrators. Super-admin support must use a separate,
// explicitly audited workflow rather than a tenant endpoint without context.
function requireFinanceReadAccess(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  if (!['owner', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'Only company owners and administrators can view financial records.' });
  }

  const companyId = req.user?.companyId || req.user?.company_id;
  if (!companyId) {
    return res.status(401).json({ error: 'Company context is required.' });
  }

  return next();
}

module.exports = requireFinanceReadAccess;
