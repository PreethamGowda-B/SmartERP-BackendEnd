# Proposal: AI audit log access and retention

**Status: pending database-role and product-policy review. Not registered as a migration and not executed.**

## Source findings

- `ai_audit_logs` is created by migrations 018 and 048. Neither migration enables RLS or defines table grants.
- The API permits an owner to read logs for their authenticated company and a super admin to read across companies. AI audit inserts run through the backend database role.
- `db.js` sets `app.current_company_id`, `app.current_role`, and `app.bypass_rls` on each checked-out connection, then assumes `smarterp_app` except for explicit bypass contexts.
- Migration 044 uses `smarterp_app` grants plus forced RLS for other AI data tables. Migration 043 grants it select/insert on security events.
- Repository inspection cannot establish live `PUBLIC`, `anon`, `authenticated`, `service_role`, table-owner, or `smarterp_app` privileges, nor confirm that super-admin audit reads always receive the bypass context.
- The application has no defined retention period or approved deletion rule for audit records. No automatic purge is proposed.

## Proposed policy shape for review

**Threat model:** PostgreSQL custom settings such as `app.current_company_id`, `app.current_role`, and `app.bypass_rls` are mutable by a database session. They are useful tenant context for defense in depth, but they do not independently authenticate an owner or super admin. A query injection or arbitrary SQL capability under `smarterp_app` could set these values. The current `app.bypass_rls` pattern is therefore not an independent authorization boundary.

**Recommendation:** keep `smarterp_app` non-owner and `NOBYPASSRLS`; grant it only `SELECT` and `INSERT` on audit rows, with RLS restricting owner reads and inserts to the server-set company context. Do not put a super-admin exception based only on `app.current_role` or `app.bypass_rls` into this policy. If cross-company audit reads must be supported, use a separate, narrowly granted `smarterp_audit_admin` database login/connection pool held only by the backend, with no membership from `smarterp_app`, no `BYPASSRLS`, and a table-specific SELECT policy for that database role. Acquire it only after trusted server-side super-admin authorization. The identity, credential storage, connection lifecycle, grants, and separate pool do not currently exist in verified source; this is a design recommendation, not an implemented capability.

The initial policy should omit super-admin cross-company access until that separate role is designed and tested. No application role receives update or delete access. Force RLS only after verifying that each legitimate writer and reader has been mapped, the actual relation owner and role memberships are understood, and the production service never queries as a superuser/table owner.

Draft SQL for a future controlled forward migration, subject to verification against the target database's actual grants and authentication roles:

```sql
BEGIN;

ALTER TABLE public.ai_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_audit_logs_backend_select ON public.ai_audit_logs
  FOR SELECT TO smarterp_app
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), ''));

CREATE POLICY ai_audit_logs_backend_insert ON public.ai_audit_logs
  FOR INSERT TO smarterp_app
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), ''));

REVOKE ALL ON public.ai_audit_logs FROM PUBLIC;
GRANT SELECT, INSERT ON public.ai_audit_logs TO smarterp_app;
DO $$
DECLARE audit_id_sequence TEXT;
BEGIN
  audit_id_sequence := pg_get_serial_sequence('public.ai_audit_logs', 'id');
  IF audit_id_sequence IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO smarterp_app', audit_id_sequence);
  END IF;
END $$;
-- If and when cross-company audit access is implemented, separately create a
-- non-BYPASSRLS smarterp_audit_admin login, grant SELECT only, add a table-role
-- SELECT policy for it, and ensure smarterp_app is not a member of that role.
-- Revoke from anon/authenticated only after catalog and API-path review.

COMMIT;
```

## Required gates before turning this into a migration

1. Read-only query the target catalog for `relowner`, RLS flags, policies, table and sequence ACLs, inherited role memberships, and grants to `PUBLIC`, `anon`, `authenticated`, `service_role`, and `smarterp_app`.
2. Verify the API's owner read route and super-admin read/stat routes under their actual connection contexts. A GUC that says `super_admin` or bypass is not sufficient evidence of database authorization.
3. Test with actual role credentials that `smarterp_app` is not table owner, superuser, `BYPASSRLS`, or a member of `smarterp_audit_admin`; its inherited privileges must not reintroduce write/delete rights.
4. Test scoped owner reads, cross-company denial, tenant-matched inserts, required background inserts, and denied updates/deletes using the effective app role in a disposable database. Explicitly set `app.current_role='super_admin'` and `app.bypass_rls='on'` and confirm neither expands table access under the initial policy.
5. Demonstrate the remaining GUC trust boundary: an SQL session using `smarterp_app` can set `app.current_company_id` to another value. Confirm ordinary untrusted request fields cannot influence connection context and all query inputs are parameterized. If arbitrary SQL under `smarterp_app` is in threat scope, this single-role GUC design is insufficient; require database-authenticated tenant identity (for example, distinct tenant roles) before calling the RLS boundary strong isolation.
6. If super-admin cross-company reads are implemented, verify their separate role credential is only accessed after server-side authorization, cannot be assumed by `smarterp_app`, has no `BYPASSRLS`, and only gets the intended audit-table SELECT policy.
7. Decide audit retention, legal hold, export, and deletion semantics with the product owner. Until then, retain audit rows and do not add an automatic purge job.
8. Add catalog postconditions and role-level tests to the controlled migration and its verifier before any staging or production application.
