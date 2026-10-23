const { FAST_PATH_POLICIES } = require('./aiFastPathPolicy');

const FAST_PATH_ROLES = Object.freeze({
  jobs: new Set(FAST_PATH_POLICIES.completed_jobs.roles),
  payroll: new Set(FAST_PATH_POLICIES.payroll.roles),
  inventory: new Set(FAST_PATH_POLICIES.inventory.roles),
  financial: new Set(FAST_PATH_POLICIES.finance.roles),
});

function canUseAiFastPath(metric, role) {
  const normalizedRole = String(role || "").toLowerCase();
  return FAST_PATH_ROLES[metric]?.has(normalizedRole) === true;
}

module.exports = { canUseAiFastPath };
