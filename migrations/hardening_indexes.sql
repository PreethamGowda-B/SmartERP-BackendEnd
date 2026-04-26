-- ===============================
-- SmartERP Essential Indexes
-- Section 4: Keep only indexes that directly serve hot query paths.
-- Removed over-indexing to avoid write slowdowns.
-- Safe to run multiple times — all use IF NOT EXISTS / DROP IF EXISTS
-- ===============================

-- ── Core job queries (company_id is on every query) ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_company_id
  ON jobs(company_id);

CREATE INDEX IF NOT EXISTS idx_jobs_approval_status
  ON jobs(company_id, approval_status);

CREATE INDEX IF NOT EXISTS idx_jobs_assigned_to
  ON jobs(assigned_to);

CREATE INDEX IF NOT EXISTS idx_jobs_status
  ON jobs(company_id, status);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at
  ON jobs(company_id, created_at DESC);

-- ── Customer job lookup (customer portal) ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_customer_company
  ON jobs(customer_id, company_id);

-- ── Employee job visibility (source + approval_status filter) ─────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_source_approval
  ON jobs(company_id, source, approval_status);

-- ── Geofence: only accepted jobs with location ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_geofence
  ON jobs(employee_status, arrived_at)
  WHERE employee_status = 'accepted' AND arrived_at IS NULL;

-- ── SLA breach detection ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_sla_accept
  ON jobs(company_id, sla_accept_breached, assigned_at)
  WHERE sla_accept_breached = FALSE;

CREATE INDEX IF NOT EXISTS idx_jobs_sla_completion
  ON jobs(company_id, sla_completion_breached, accepted_at)
  WHERE sla_completion_breached = FALSE;

-- ── Audit log retention query ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs(created_at);

-- ── Invoice lookup ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_invoices_job_id
  ON invoices(job_id);

-- ── Error log retention ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at
  ON error_logs(created_at DESC);

-- ── Drop over-indexes that were added previously ─────────────────────────────
-- These were too granular and slow down writes without meaningful read benefit.
DROP INDEX IF EXISTS idx_jobs_company_approval;
DROP INDEX IF EXISTS idx_jobs_company_source_approval;
DROP INDEX IF EXISTS idx_jobs_status_company;
DROP INDEX IF EXISTS idx_jobs_employee_status;
DROP INDEX IF EXISTS idx_jobs_sla_accept;
DROP INDEX IF EXISTS idx_jobs_sla_completion;
DROP INDEX IF EXISTS idx_audit_logs_company_created;
DROP INDEX IF EXISTS idx_audit_logs_retention;
DROP INDEX IF EXISTS idx_invoices_job_company;
DROP INDEX IF EXISTS idx_notif_prefs_user_event;
DROP INDEX IF EXISTS idx_notif_prefs_customer_event;
DROP INDEX IF EXISTS idx_employee_profiles_location;
