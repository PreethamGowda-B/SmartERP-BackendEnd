# SmartERP Attendance — Schema Baseline Report

**Date:** 2026-10-17  
**Decision:** **NO-GO** for database integration verification.  
**Scope:** Source-only review of tracked schema, migration registration, startup/deployment documentation, runtime attendance SQL, correction SQL, RLS setup, and test database configuration.  
**Safety:** No `.env` file was read. No database/API connection, migration, schema change, attendance-data access, commit, push, or deployment was performed.

## Executive conclusion

The repository does not establish one authoritative database schema that can be safely used to create the current attendance application database. The platform guide describes `schema.sql` as the base schema for fresh deployments and says migrations run at startup, but the tracked base attendance table uses legacy column names and the registered migration sequence contains no attendance-table migration that adds or maps the runtime columns. The runtime attendance-correction table has no tracked create-table definition. Architecture documentation itself calls out schema drift.

There is also no confirmed disposable test database or explicit test-only credential in the process environment. The root `docker-compose.yml` defines a PostgreSQL service with a persistent named volume (`db-data`), so it cannot be assumed disposable. The repository `.env` exists, has an unknown target, and was not inspected or used.

The authoritative runtime database schema and a safe database target therefore remain **unestablished**. Stop before any database connection or integration test.

## 1. Tracked schema and deployment evidence

### What the repository documents

- `README.md:15–23` describes manually applying `schema.sql` with `psql`, then starting the server.
- `SmartERP_Platform_Documentation.md:1531–1539` calls `schema.sql` the base schema for fresh deployments and says migrations run on server startup.
- `server.js:477–490` runs `fixDatabaseConstraints()`, `fixMaterialRequestsSchema()`, `setupDocumentsTable()`, and `runNumberedMigrations()` during database initialization. Later startup code applies additional workflow/HR/communication SQL (`server.js:704–727`). Failed migration statements are logged and may be skipped rather than stopping startup.
- `migrations/autoMigrate.js:203–230` registers a hard-coded numbered-migration list. That list does not include a migration creating or reconciling `attendance` or `attendance_corrections`. It omits some numbered SQL files and does not include standalone `migrations/rls_policies.sql`.
- `scripts/runSchema.js` applies `schema.sql` as a separate operation; there is no tracked deployment artifact that proves that this script and all startup SQL have been applied to a particular database in a defined, versioned order.
- `ARCHITECTURE.md:2520–2530` explicitly records schema drift between `schema.sql` and production DB. The docs therefore do not claim the tracked base file is an exact production/runtime dump.

### Tracked `attendance` definition

`schema.sql:127–140` defines:

| Column | Tracked type/constraint |
|---|---|
| `id` | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
| `user_id` | `UUID REFERENCES users(id)`; nullable in this definition |
| `company_id` | `UUID REFERENCES companies(id)`; nullable in this definition |
| `date` | `DATE NOT NULL` |
| `status` | `VARCHAR(50) DEFAULT 'present'` |
| `clock_in`, `clock_out` | `TIMESTAMP` |
| `working_hours` | `NUMERIC DEFAULT 0` |
| `location` | `VARCHAR(255)` |
| `notes` | `TEXT` |
| `created_at` | `TIMESTAMP DEFAULT NOW()` |

`schema.sql:298–299` adds ordinary indexes on `user_id` and `company_id`. The table definition has no foreign-key cascade specified, no `updated_at`, and no unique key for one row per employee/company/work date. `migrations/001_hardening_indexes_and_migration.sql:45–47` adds the same ordinary indexes; it does not add attendance uniqueness.

This is the only tracked `CREATE TABLE attendance` definition found. It is not compatible with current runtime queries as-is.

## 2. Runtime attendance contract and unresolved types

The following columns are referenced by current SQL but are absent from the tracked attendance table definition. Because no authoritative runtime table DDL or schema dump is tracked, their actual database types, nullability, defaults, constraints, foreign keys, indexes, and RLS state cannot be certified here.

| Runtime column(s) | Runtime use / implied value shape | Authoritative DB definition |
|---|---|---|
| `id` | Row identity; updates and correction joins | Tracked base is UUID PK; runtime DB type not confirmed |
| `user_id`, `company_id` | Tenant/employee identity; queries often cast to text; `safeCompanyId` accepts integer strings and UUIDs | Tracked base uses UUID FKs; actual runtime types and FK rules not confirmed |
| `date` | Company-local work date comparisons; service passes `YYYY-MM-DD` | Tracked base is `DATE`; runtime DB type not confirmed |
| `check_in_time`, `check_out_time` | Punch instants; date arithmetic and `Date` inputs | Missing from base (`clock_in`/`clock_out` are named instead); runtime type not confirmed |
| `working_hours` | Numeric calculated duration | Base defines `NUMERIC`; runtime precision/scale/default not confirmed |
| `status`, `is_late` | Status string and late flag | Base defines `status VARCHAR(50)`; `is_late` absent; runtime definition not confirmed |
| `clock_in_method`, `clock_out_method` | Values include manual, biometric, automatic | Missing; type/allowed-value constraint not found |
| `biometric_device_id`, `edited_by` | Device/editor identifiers | Missing; referenced tables/FKs and types not established |
| `is_auto_clocked_out`, `is_manual`, `is_processed` | Boolean workflow flags | Missing; defaults/nullability not established |
| `processed_at`, `updated_at` | Processing/update timestamps | Missing; timestamp type/default not established |
| `location`, `notes`, `created_at` | Selected/exported history metadata | Base definitions exist; current runtime compatibility not verified |

### Attendance-correction runtime contract

`routes/attendance.js:471–475,688–707,766–780` references `attendance_corrections` columns `id`, `attendance_id`, `user_id`, `requested_check_in`, `requested_check_out`, `reason`, `created_at`, `status`, `reviewed_by`, and `reviewed_at`. No `CREATE TABLE attendance_corrections` or `ALTER TABLE attendance_corrections` definition was found in tracked `schema.sql` or `migrations/`. Consequently, column types, required fields, status constraints/defaults, foreign keys to attendance/users/reviewers, uniqueness, indexes, and RLS policy are all **unknown from this checkout**.

### Why `schema.sql` and runtime SQL differ

The base schema predates or does not encode the current attendance implementation. It names punch fields `clock_in`/`clock_out`; current routes, the policy service, dashboard, HR, reports, payroll, notifications, and gatekeeper use `check_in_time`/`check_out_time` and other workflow columns. Current startup migrations do not supply an attendance-specific rename/add/backfill migration. The report route’s `ensureReportColumns()` only adds `working_hours` and `is_late`; it does not reconcile the full runtime contract. The platform documentation’s generic statement that migrations apply at startup is insufficient to establish which external/manual schema changes exist in a target database.

Thus `schema.sql` is the documented base for fresh setup, but it is **not a verified authoritative schema for the current attendance runtime**. No alternate supported attendance schema was found in tracked source.

## 3. RLS and database invariants required for safe tests

- `migrations/011_standardize_uuid_and_core_rls.sql` enables attendance RLS and defines a company predicate (`company_id::text` against `app.current_company_id`) with explicit system/admin exceptions. This migration is registered in `autoMigrate.js`.
- `migrations/rls_policies.sql:79–91` enables **and forces** attendance RLS and defines a separate tenant policy. It is not in the numbered startup list; `scripts/apply-rls.js` is a separate manual path. The effective policy set, table owner, role grants, `smarterp_app` availability, `BYPASSRLS` properties, and session-context behavior in a real database are not known.
- Runtime `db.js` configures role/session context from async-local tenant state, but code inspection cannot prove database roles/policies have been provisioned as expected.
- Required invariants to inspect read-only in the future disposable DB: `attendance` column/type/default/nullability map; correction table map; foreign keys; all unique/partial indexes and duplicate groups for `(company_id,user_id,date)`; RLS enabled/forced state and policy definitions; database roles and grants; `company_settings` uniqueness and RLS; advisory-lock support; and the exact migration ledger/order.
- Advisory locks serialize only application paths that take matching transaction locks. They do not replace a verified database uniqueness invariant for writers that skip the lock. No actual unique attendance constraint is supported by the tracked schema.

## 4. Disposable database prerequisites — NOT MET

No database variable is set in the current process environment. No explicit `TEST_DATABASE_URL` or test-only credential is configured. `tests/rls.test.js` accepts `DATABASE_URL` and applies RLS DDL, without a source-level production-host/disposable-database guard; it was not run.

`docker-compose.yml` defines a Postgres service and persistent named volume `db-data` with default development credentials. That is a persistent development service, not evidence of a fresh disposable test database. It was not started. No external test DB/container was identified or independently confirmed.

Minimum prerequisites before any connection:

1. Supply or approve a reviewed, authoritative attendance and correction schema baseline (including exact types and constraints) and the complete migration order used to create it. A sanitized schema-only dump from an explicitly named disposable environment is acceptable; production credentials or records are not.
2. Identify an independently verified disposable PostgreSQL instance/database, with a fresh database name, isolated host/credentials, synthetic fixtures only, and an explicit test-only connection variable. A human-readable host/database confirmation is required before connecting; do not reuse `.env` or a generic `DATABASE_URL`.
3. Establish expected RLS roles/grants and the approved policy scripts in that test database without weakening RLS for normal-role tests.
4. If biometric route integration is later approved, provide an isolated Redis endpoint and vendor contract fixture. Biometric remains disabled until then.

Until those prerequisites are met, do not inspect duplicate rows, apply migrations, run `tests/rls.test.js`, launch `server.js`, or run database scripts.

## 5. Request-time DDL review — CONFIRMED

`routes/reports.js:12–18` defines `ensureReportColumns()` with:

- `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS working_hours NUMERIC`
- `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS is_late BOOLEAN DEFAULT false`

`GET /api/reports/attendance` calls it at `routes/reports.js:81–86` before executing its report query. Other report handlers also call the helper (`routes/reports.js:143,210,282,338,396,443,486`). Therefore ordinary HTTP report requests can mutate the schema if either column is missing. The helper catches/logs DDL errors and allows the request path to continue, which can then expose a query failure if the expected column remains absent.

### Recommended separately reviewed removal

After the authoritative schema is established, prepare a reviewed, versioned migration or reviewed initialization step that adds only columns confirmed missing, with approved types/defaults/nullability and compatibility checks. Register it in the documented migration sequence and test it on a fresh disposable database and an upgrade fixture. Then remove `ensureReportColumns()` and all calls from HTTP handlers so report requests are read-only with respect to schema. Do not add or rename attendance columns based on assumptions: in particular, do not use this two-column helper as a substitute for resolving the broader `clock_in` versus `check_in_time` contract. No migration or code change was made in this task.

## 6. Integration verification plan after the gate opens

Only after the prerequisites above are met, use synthetic two-company fixtures and run:

1. Read-only schema, migration-ledger, policy/grant, duplicate, FK, and index inventory before any mutation.
2. Owner, employee, HR, customer, and admin role authorization tests; two-company Owner/personal attendance, payroll, dashboard, AI summary, reports, and notification isolation with actual RLS enabled.
3. Concurrent same-employee/work-date clock-ins from independent PostgreSQL connections; include scheduler/manual processor overlap and inspect that no duplicate is created.
4. Correction approval concurrent review, injected failure/rollback, company boundary, and already-processed attendance rejection.
5. Approved leave before and after same-day absence processing, plus historical-row preservation.
6. Exact cutoff, delayed scheduler tick, repeated run, restart recovery, and transaction failure/retry; verify persisted state and notifications only as contractually expected.
7. Asia/Kolkata UTC rollover and all existing route response shapes consumed by Owner/Employee/HR screens.
8. Biometric only after vendor docs define signed bytes, timestamp units, nonce/replay, device-company mapping, and fixtures; keep integration disabled meanwhile.

Do not propose or apply a unique index until the disposable database proves the actual identity key and a read-only duplicate inventory has been reviewed. Do not delete, merge, or rewrite existing records.

## 7. Working-tree and completion record

- Backend: this report is the only new file for this task. The prior `SMARTERP_ATTENDANCE_INTEGRATION_VERIFICATION_REPORT.md` remains unchanged.
- Frontend: pre-existing uncommitted edits remain in `app/employee/time-tracking/page.tsx` and `app/employee/time/page.tsx`; they were not modified or staged.
- Tests run for this task: none. Prior safe unit-test results remain documented in the integration verification report; they are not database integration evidence.
- Production verification: none. No claim of runtime or production readiness is made.

## Go/no-go

**NO-GO — do not connect to a database or run integration tests yet.** The authoritative runtime schema/migration baseline, complete attendance-correction definition, confirmed disposable database, and explicit test-only credentials are missing. Resolve these prerequisites first; keep biometric disabled and treat request-time DDL removal as a separate reviewed change.
