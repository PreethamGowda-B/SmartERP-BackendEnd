const COMPANY_ATTENDANCE_ROLES = new Set(["owner", "admin", "hr"]);

function resolveAttendanceSummaryScope(role) {
  const normalizedRole = String(role || "").toLowerCase();
  if (COMPANY_ATTENDANCE_ROLES.has(normalizedRole)) return "company";
  return null;
}

async function loadAttendanceSummary({ role, companyId, dataService }) {
  const scope = resolveAttendanceSummaryScope(role);
  if (!scope || !companyId || !dataService) return null;
  const summary = await dataService.getCompanyAttendanceSummary({ companyId });
  return { scope, summary };
}

module.exports = { loadAttendanceSummary, resolveAttendanceSummaryScope };
