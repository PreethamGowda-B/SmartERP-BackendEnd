-- ============================================================================
-- Migration 053: Drop Exact Duplicate Non-Constraint Indexes (20 pairs)
--
-- Independent maintenance migration separated from Migration 052.
-- All 20 dropped indexes have constraint = NULL (no PK, UNIQUE, or FK depends
-- on them) and are exact btree duplicates of a retained active/canonical index.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS public.idx_attendance_clock_in;
DROP INDEX IF EXISTS public.idx_attendance_company_date;
DROP INDEX IF EXISTS public.idx_corrections_attendance;
DROP INDEX IF EXISTS public.idx_corrections_status;
DROP INDEX IF EXISTS public.idx_corrections_user;
DROP INDEX IF EXISTS public.idx_employee_profiles_user;
DROP INDEX IF EXISTS public.idx_inventory_company;
DROP INDEX IF EXISTS public.idx_invoices_company_id;
DROP INDEX IF EXISTS public.idx_invoices_customer;
DROP INDEX IF EXISTS public.idx_invoices_job_id;
DROP INDEX IF EXISTS public.idx_job_action_requests_company;
DROP INDEX IF EXISTS public.idx_job_action_requests_job;
DROP INDEX IF EXISTS public.idx_materials_company_id;
DROP INDEX IF EXISTS public.idx_materials_requested_by;
DROP INDEX IF EXISTS public.idx_messages_receiver;
DROP INDEX IF EXISTS public.idx_messages_sender;
DROP INDEX IF EXISTS public.idx_notifications_company;
DROP INDEX IF EXISTS public.idx_notifications_user_id_read;
DROP INDEX IF EXISTS public.idx_sub_events_company;
DROP INDEX IF EXISTS public.idx_users_company;

COMMIT;
