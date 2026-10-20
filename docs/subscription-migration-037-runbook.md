# Subscription migration 037 isolated test runbook

Migration 037 is not run during application startup. The explicit
`npm run migrate:subscription` command is the only supported executor.

## DBA preparation required

Provision a separate test database and a dedicated non-superuser, non-`BYPASSRLS`
role. The test endpoint must be different from the application's configured
database target. Do not use the default `postgres` database or a production
database. Confirm the database is isolated from production data and systems
before marking it.

In that confirmed test database, a DBA can create a one-row identity marker.
Use the exact database name and role that the dedicated migration connection
will report, and assign a unique approval ID. This is a deliberate database
write that must happen only after the isolation review; it has not been run by
this change.

```sql
CREATE TABLE public.smarterp_test_database_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  environment TEXT NOT NULL CHECK (environment = 'isolated_test'),
  isolation_id TEXT NOT NULL,
  database_name TEXT NOT NULL,
  database_role TEXT NOT NULL,
  database_oid OID NOT NULL
);

INSERT INTO public.smarterp_test_database_identity
  (singleton, environment, isolation_id, database_name, database_role, database_oid)
VALUES
  (TRUE, 'isolated_test', 'replace-with-unique-DBA-approval-ID',
   'replace-with-test-database-name', 'replace-with-migration-role',
   (SELECT oid FROM pg_database WHERE datname='replace-with-test-database-name'));

GRANT SELECT ON public.smarterp_test_database_identity TO smarterp_subscription_migrator;
```

Replace each `replace-with-...` string and the sample role identifier before
executing. Confirm the OID query returns exactly one row. The operator must set
the matching `SMARTERP_SUBSCRIPTION_TEST_DATABASE_OID` environment value.

Do not grant the marker role write access through this procedure. The migration
role needs only the object privileges required by the reviewed migration and
must not be a superuser or have `BYPASSRLS`.

## Operator setup

Set the commented `SMARTERP_*` values in the backend's local environment file
using a dedicated test connection URL. Keep the normal `DATABASE_URL` set to
the application target so the script can reject an accidental identical
connection. Never paste the URL or credentials into logs, chat, or the report.

The script checks the URL against separately configured host, port, database,
role, and database OID values; compares those to `current_database()`,
`current_user`, the server port, and the catalog database OID after connecting;
checks the marker row and its unique
isolation ID; rejects the `postgres` database/role and privileged roles; then
checks stable legacy plan IDs before applying anything. The migration runs in
the existing forward runner's transaction/advisory-lock/checksum mechanism.
Post-verification compares all three plan names, prices, quotas and flags to
the backend catalog and checks storage columns, payment foreign keys, RLS,
policies, `smarterp_app` safety and grants. A failed post-check rolls back.

Only after the DBA confirms isolation and provisions the marker should an
authorized operator invoke the script with
`SMARTERP_SUBSCRIPTION_SEED_CONFIRM=APPLY_TO_CONFIRMED_TEST_DATABASE`.
This change does not execute that procedure.

## Legacy plan mapping

The supported stable-ID mapping is `1 Free -> 1 Starter`,
`2 Basic -> 2 Professional`, and `3 Pro -> 3 Enterprise`. Migration 037
updates those three rows in place, so existing `companies.plan_id` references
continue to resolve and no duplicate plan rows are created. Other plan IDs and
all subscription/event/payment history are left in place. Preflight refuses
missing, unexpected, or ambiguous labels rather than guessing. Review custom
plans and current company assignments before approving the test run; any
production migration requires a separately reviewed rollout and backup plan.
