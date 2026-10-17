const AttendancePolicy = require('./attendancePolicyService');

const HR_ANALYTICS_ROLES = new Set(['owner', 'admin', 'hr']);

function canAccessHrAnalytics(role) {
  return HR_ANALYTICS_ROLES.has(String(role || '').toLowerCase());
}

function dateRangeForWorkDate(period, workDate) {
  const end = new Date(`${workDate}T00:00:00.000Z`);
  if (!Number.isFinite(end.getTime())) throw new Error('Invalid attendance work date');
  const start = new Date(end);
  const subtractMonths = (months) => {
    const day = start.getUTCDate();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - months);
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, lastDay));
  };
  switch (period) {
    case 'week': start.setUTCDate(start.getUTCDate() - 7); break;
    case 'quarter': subtractMonths(3); break;
    case 'year': subtractMonths(12); break;
    default: subtractMonths(1); break;
  }
  return { startDate: start.toISOString().slice(0, 10), endDate: workDate };
}

function todayForPolicy(now, policy) {
  return AttendancePolicy.localDate(now, policy?.timezone || 'Asia/Kolkata');
}

module.exports = { canAccessHrAnalytics, dateRangeForWorkDate, todayForPolicy };
