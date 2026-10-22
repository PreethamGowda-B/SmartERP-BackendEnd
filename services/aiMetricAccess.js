const FAST_PATH_ROLES = Object.freeze({
  jobs: new Set(["owner", "admin", "hr", "employee"]),
  payroll: new Set(["owner", "admin", "hr"]),
  inventory: new Set(["owner", "admin", "hr", "employee"]),
  financial: new Set(["owner", "admin"]),
});

function canUseAiFastPath(metric, role) {
  const normalizedRole = String(role || "").toLowerCase();
  return FAST_PATH_ROLES[metric]?.has(normalizedRole) === true;
}

module.exports = { canUseAiFastPath };
