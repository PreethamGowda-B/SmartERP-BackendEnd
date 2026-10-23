'use strict';

function isEmployeeAssignedJobsPrompt(role, prompt) {
  const normalizedRole = String(role || '').toLowerCase();
  const normalizedPrompt = String(prompt || '').toLowerCase();
  return normalizedRole === 'employee'
    && /\b(my|assigned to me)\b/.test(normalizedPrompt)
    && /\b(jobs?|tasks?)\b/.test(normalizedPrompt);
}

function createEmployeeAssignedJobsResponse(result, latencyMs = 0) {
  const jobs = Array.isArray(result?.jobs) ? result.jobs : [];
  const count = Number.isFinite(Number(result?.totalCount)) ? Number(result.totalCount) : jobs.length;
  const titles = jobs.map((job) => job?.title).filter(Boolean);
  const text = count === 0
    ? 'You currently have no directly assigned jobs.'
    : `You have **${count}** directly assigned job(s).${titles.length ? ` Recent jobs: ${titles.join(', ')}.` : ''}`;

  return {
    text,
    widget: { type: 'KPI_SUMMARY', title: 'My Assigned Jobs', metrics: [{ label: 'Assigned Jobs', value: count }] },
    navigation: { path: '/employee/jobs', label: 'Open Assigned Jobs' },
    confidenceScore: 1.0,
    sources: ['Assigned Jobs (Live PostgreSQL)'],
    autoSelectedModel: 'Jobs AI',
    telemetry: { latencyMs },
  };
}

module.exports = { isEmployeeAssignedJobsPrompt, createEmployeeAssignedJobsResponse };
