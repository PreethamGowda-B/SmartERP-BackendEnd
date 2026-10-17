function approvalBlockReason(run, now = new Date()) {
  if (!run) return 'Audit run not found for this company.';
  if (run.is_approved) return 'This audit was already approved.';
  if (!['passed', 'needs_review', 'failed'].includes(run.audit_status)
    || Number(run.checks_executed) !== 7 || Number(run.record_count) === 0) {
    return 'All seven checks must execute against at least one payroll record.';
  }
  let checks = run.check_results;
  if (typeof checks === 'string') {
    try { checks = JSON.parse(checks); } catch { checks = null; }
  }
  if (!Array.isArray(checks) || checks.length !== 7
    || checks.some((check) => ['unable_to_validate', 'not_applicable'].includes(check.status))) {
    return 'One or more required checks could not be validated.';
  }
  if (Number(run.year) > now.getFullYear() || (Number(run.year) === now.getFullYear() && Number(run.month) > now.getMonth() + 1)) {
    return 'Future payroll periods cannot be marked complete.';
  }
  if (run.is_stale) return 'Payroll or source data changed after this audit. Run the audit again.';
  if (Number(run.unresolved_critical_count || 0) > 0) return 'Unresolved critical findings remain.';
  return null;
}

module.exports = { approvalBlockReason };
