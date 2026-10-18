-- SmartERP migration 034: restrict Production & Dispatch table access.
-- The 033 schema exists on the current Supabase target. Supabase default ACLs
-- also granted TRUNCATE and other privileges to API roles; RLS does not protect
-- TRUNCATE. Keep access only for the backend's non-BYPASSRLS application role.

BEGIN;

REVOKE ALL PRIVILEGES ON TABLE
  production_sequences, production_orders, production_batches, production_reports,
  production_order_materials, production_inspections, production_dispatches,
  production_dispatch_adjustments, production_events, production_idempotency
FROM PUBLIC;

DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','smarterp_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE production_sequences, production_orders, production_batches, production_reports, production_order_materials, production_inspections, production_dispatches, production_dispatch_adjustments, production_events, production_idempotency FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON TABLE production_sequences, production_orders, production_batches TO smarterp_app;
GRANT SELECT, INSERT ON TABLE
  production_reports, production_order_materials, production_inspections,
  production_dispatches, production_dispatch_adjustments, production_events,
  production_idempotency
TO smarterp_app;

COMMIT;
