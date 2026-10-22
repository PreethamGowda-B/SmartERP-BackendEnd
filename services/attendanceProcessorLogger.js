const COUNTERS = ['auto_clocked_out', 'marked_absent', 'records_locked'];

function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function summarizeAttendanceResults(results, durationMs) {
  const rows = Array.isArray(results) ? results : [];
  const companies = new Set();
  const totals = { auto_clocked_out: 0, marked_absent: 0, records_locked: 0 };

  for (const result of rows) {
    if (result?.company_id !== undefined && result?.company_id !== null) {
      companies.add(String(result.company_id));
    }
    for (const field of COUNTERS) totals[field] += count(result?.[field]);
  }

  return {
    companies: companies.size,
    ...totals,
    errors: 0,
    duration_ms: Math.max(0, Math.round(count(durationMs))),
  };
}

function logAttendanceProcessorCompletion(results, durationMs, logger = console) {
  const rows = Array.isArray(results) ? results : [];
  for (const result of rows) {
    const duplicates = count(result?.duplicate_records);
    const invalidTimeRanges = count(result?.invalid_time_ranges);
    if (!duplicates && !invalidTimeRanges) continue;

    logger.warn(
      `[attendance-processor] anomaly company_id=${String(result?.company_id ?? 'unknown')} work_date=${String(result?.date ?? 'unknown')} duplicate_records=${duplicates} invalid_time_ranges=${invalidTimeRanges}`
    );
  }

  const summary = summarizeAttendanceResults(rows, durationMs);
  logger.info(
    `[attendance-processor] completed companies=${summary.companies} auto_clocked_out=${summary.auto_clocked_out} marked_absent=${summary.marked_absent} records_locked=${summary.records_locked} errors=${summary.errors} duration_ms=${summary.duration_ms}`
  );
  return summary;
}

function logAttendanceProcessorFailure(error, logger = console, label = 'failed') {
  const context = error?.attendanceProcessorContext;
  const company = context?.companyId !== undefined ? ` company_id=${String(context.companyId)}` : '';
  const workDate = context?.workDate ? ` work_date=${String(context.workDate)}` : '';
  logger.error(
    `[attendance-processor] ${label}${company}${workDate}`,
    error?.message || (typeof error === 'string' ? error : 'Unknown attendance processor error'),
    error?.stack || ''
  );
}

module.exports = {
  summarizeAttendanceResults,
  logAttendanceProcessorCompletion,
  logAttendanceProcessorFailure,
};
