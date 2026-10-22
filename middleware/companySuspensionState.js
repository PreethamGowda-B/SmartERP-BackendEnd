'use strict';

function createCompanySuspensionChecker(queryCompanyStatus) {
  if (typeof queryCompanyStatus !== 'function') {
    throw new TypeError('queryCompanyStatus must be a function');
  }

  const inFlight = new Map();

  return async function isCompanySuspended(companyId) {
    if (!companyId) return false;

    const key = String(companyId);
    let pending = inFlight.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => queryCompanyStatus(companyId))
        .then((companyRes) => companyRes.rows.length > 0 && (
          companyRes.rows[0].status === 'suspended' || companyRes.rows[0].is_susp === 'true'
        ))
        .finally(() => {
          if (inFlight.get(key) === pending) inFlight.delete(key);
        });
      inFlight.set(key, pending);
    }

    return pending;
  };
}

module.exports = { createCompanySuspensionChecker };
