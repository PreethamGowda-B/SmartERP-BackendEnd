'use strict';

function createCompanySuspensionChecker(queryCompanyStatus, { cacheMs } = {}) {
  if (typeof queryCompanyStatus !== 'function') {
    throw new TypeError('queryCompanyStatus must be a function');
  }

  const inFlight = new Map();
  const resolved = new Map();
  const resolvedCacheMs = Math.min(
    60_000,
    Math.max(0, Number.parseInt(cacheMs ?? process.env.COMPANY_SUSPENSION_CACHE_MS ?? '30000', 10) || 0)
  );

  async function isCompanySuspended(companyId) {
    if (!companyId) return false;

    const key = String(companyId);
    const cached = resolved.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.suspended;
    if (cached) resolved.delete(key);
    let pending = inFlight.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => queryCompanyStatus(companyId))
        .then((companyRes) => {
          const suspended = companyRes.rows.length > 0 && (
            companyRes.rows[0].status === 'suspended' || companyRes.rows[0].is_susp === 'true'
          );
          if (resolvedCacheMs) {
            resolved.set(key, { suspended, expiresAt: Date.now() + resolvedCacheMs });
            if (resolved.size > 2000) {
              const now = Date.now();
              for (const [cacheKey, entry] of resolved) {
                if (entry.expiresAt <= now) resolved.delete(cacheKey);
              }
            }
          }
          return suspended;
        })
        .finally(() => {
          if (inFlight.get(key) === pending) inFlight.delete(key);
        });
      inFlight.set(key, pending);
    }

    return pending;
  }

  isCompanySuspended.invalidate = function (companyId) {
    if (!companyId) return;
    const key = String(companyId);
    resolved.delete(key);
    inFlight.delete(key);
  };

  isCompanySuspended.clear = function () {
    resolved.clear();
    inFlight.clear();
  };

  return isCompanySuspended;
}

module.exports = { createCompanySuspensionChecker };
