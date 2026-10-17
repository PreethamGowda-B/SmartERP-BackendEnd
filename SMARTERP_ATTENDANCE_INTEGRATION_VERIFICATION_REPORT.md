# SmartERP Attendance — Isolated Integration Verification Report

**Date:** 2026-10-17  
**Outcome:** Database integration phase blocked before any connection.  
**Scope:** Rechecked the four requested attendance reports, current backend/frontend diffs, tracked schema and migrations, runtime attendance SQL, RLS wiring, and safe existing unit tests.  
**Safety:** No database/API connection, migration, attendance data access or edits, commit, push, or deployment was performed.

## Executive result

The remediation is supported by source checks and pure unit/mocked tests, but it cannot be verified against a supported isolated database from this checkout. `schema.sql` does not match the attendance columns used at runtime; the startup migration list contains no attendance table reconciliation; the available test setup requires an externally supplied `DATABASE_URL`; and no test-only database environment variable is configured. The repository also contains an `.env` file of unknown target, which was not read or used. Under the task’s safety gate, database integration, duplicate inspection, and route tests were not attempted.

No targeted code fix was made. The only new file is this report. The pre-existing, uncommitted Employee Time UI edits in `SmartERP-Frontend/app/employee/time-tracking/page.tsx` and `app/employee/time/page.tsx` were preserved and left untouched.

## 1. Schema baseline and compatibility — FAIL / BLOCKED

### Tracked schema and migration sequence

- `schema.sql:127–140` creates `attendance` with `id`, `user_id`, `company_id`, `date`, `status`, `clock_in`, `clock_out`, `working_hours`, `location`, `notes`, and `created_at`. Its `CREATE TABLE IF NOT EXISTS` does not upgrade a pre-existing table.
- Runtime routes/services use a different shape, including `check_in_time`, `check_out_time`, `is_late`, `clock_in_method`, `clock_out_method`, `biometric_device_id`, `is_auto_clocked_out`, `is_manual`, `edited_by`, `is_processed`, `processed_at`, and `updated_at` (for example `routes/attendance.js:139–145, 239–242, 701–704`; `services/attendancePolicyService.js:171–202`). These columns are not defined for attendance in tracked `schema.sql` or an attendance-specific migration found in `migrations/`.
- `migrations/autoMigrate.js:203–230` lists numbered migrations run during server startup; the list does not create or reconcile the attendance table. `server.js:487–490` invokes that startup runner, and later startup code separately applies workflow/HR/message SQL (`server.js:704–727`). `scripts/runSchema.js` executes `schema.sql` independently. The repository therefore does not document one complete, reproducible baseline that yields the runtime attendance schema.
- `migrations/001_hardening_indexes_and_migration.sql` adds ordinary user/company attendance indexes, not a unique attendance key. No tracked attendance uniqueness constraint was found.
- `migrations/011_standardize_uuid_and_core_rls.sql` is included by the numbered runner and adds an attendance RLS policy. `migrations/rls_policies.sql` adds `FORCE ROW LEVEL SECURITY`, but it is not in the numbered startup list; `scripts/apply-rls.js` is a separate manual path. Whether the stronger policies are installed in any database is unknown.
- `migrations/workflow_enhancement_migration.sql` defines `company_settings.company_id` as `TEXT` with `UNIQUE (company_id, setting_key)` and is applied through a separate server startup path. That does not resolve the attendance column mismatch.

### Missing safety prerequisites

- There is no configured test-only database URL in the process environment. The environment-variable inventory contained no database/PG/test variable names. `tests/rls.test.js` expects a manually supplied `DATABASE_URL` and applies `migrations/rls_policies.sql` during the test; it is database-mutating and was not run.
- No disposable test database was identified or independently confirmed. The repository `.env` was intentionally not read because its target is unknown.
- The missing supported baseline is the authoritative attendance DDL/schema snapshot (or reviewed migration chain) that establishes the runtime columns and types, the actual company/user ID types and foreign-key rules, correction table schema, applied RLS policies/grants, and attendance uniqueness constraints. A schema snapshot from a known disposable database would also establish this, but none was supplied.

**Decision:** Stop before connecting. Do not run server startup, `run-schema`, `migrate`, `tests/rls.test.js`, or any route that might perform DDL against an unknown database.

## 2. Exact tests run and results

| Check | Result | Evidence limit |
|---|---|---|
| `npm test` (`node --test tests/unit.test.js`) | **PASS — 84 passed, 0 failed** | Self-contained unit suite; does not exercise PostgreSQL routes or deployed schema. |
| `node --test tests/attendancePolicyService.test.js tests/biometricWebhookAuth.test.js tests/attendanceRemediation.test.js` | **PASS — 22 passed, 0 failed** | Pure policy/auth tests plus service mocks and source-text assertions; not database/route integration. |
| Two-company isolated database tests | **NOT RUN — blocked** | No supported schema baseline or confirmed disposable DB. |
| Independent-connection concurrency, RLS, correction transaction/race, scheduler restart/recovery tests | **NOT RUN — blocked** | Require a disposable DB with supported schema and controlled test configuration. |
| Biometric gateway fixture/integration | **NOT RUN — blocked** | No vendor contract or gateway-compatible fixtures were available. |
| `/api/reports/attendance` runtime test | **NOT RUN — intentionally excluded** | It executes request-time `ALTER TABLE` through `ensureReportColumns()`. |

The implementation and remediation reports record earlier syntax/type/diff checks; those are not represented here as integration evidence and were not rerun as part of this verification.

## 3. Tenant isolation and role authorization

| Area | Classification | Evidence and limitation |
|---|---|---|
| HR analytics role check | **PASS — source + helper test** | `routes/hr.js:55` calls `canAccessHrAnalytics`; `services/attendanceAccess.js` allows normalized owner/admin/HR only. The focused suite checks the allow-list and source wiring. No HTTP/database role test was run. |
| Employee punch identity and company | **PASS — source only** | `routes/attendance.js:117–145,217–242` derives user/company from authenticated identity, verifies membership on clock-in, scopes row reads/updates, and takes transaction advisory locks. No route test was run. |
| `/process-daily` authorization/scope | **PASS — source only** | `routes/attendance.js:980–1009` permits owner/admin, derives company from token, limits date range, and calls company-scoped `processCompanyDate`. No cross-company mutation test was run. |
| Attendance report/query company predicates | **PASS — source assertion only** | The remediation test checks expected company-predicate text in dashboard, command center, report, payroll, attendance, AI, and notification sources. This does not prove query results under RLS or schema types. |
| RLS activation, grants, and request ALS propagation | **NOT VERIFIED** | Policies exist in tracked SQL, but the RLS policy script is separate from the startup migration list and the actual database role/policy state was not queried. |
| Two-company results for Owner Attendance, personal attendance, payroll, dashboard, AI, reports, notifications | **NOT VERIFIED** | No isolated database was available; source predicates and helper tests are not tenant integration tests. |

## 4. Concurrency, corrections, leave, and scheduler

| Area | Classification | Evidence and limitation |
|---|---|---|
| Concurrent clock-in locking | **PASS — source only** | `routes/attendance.js:127–145` uses a transaction-scoped advisory lock keyed by company/user/work date, selects existing rows `FOR UPDATE`, and returns conflict for multiple existing rows. A missing-row race is not protected by a tracked unique constraint. Independent connections were not tested. |
| Database uniqueness / duplicate records | **FAIL — tracked schema; deployed state NOT VERIFIED** | The tracked baseline and migrations define no unique `(company_id,user_id,date)` attendance key. Duplicate groups could not be inspected without the blocked DB step. No records were altered. |
| Correction approval atomicity | **PASS — source only** | `routes/attendance.js:678–720` locks the correction and attendance rows and updates both in `withAttendanceTransaction`; HR request review likewise uses a transaction in `routes/hr.js`. Race, rollback, and processed-row behavior were not exercised against PostgreSQL. |
| Approved leave before/after same-day absence processing | **PASS — mocked service test** | `tests/attendanceRemediation.test.js` covers both mocked orderings and prevents historical rewrite. Database transaction/RLS behavior remains unverified. |
| Automatic clock-out policy and retry logic | **PASS — source + pure/mock tests** | `jobs/dailyAttendanceProcessor.js:47–61` schedules every minute and performs startup recovery; `services/attendancePolicyService.js:146+` applies due-time, locking, and idempotent row updates. Unit tests exercise due time and mocked repeated/delayed processing. Actual cron execution, restart, multiple workers, rollback, and persisted row behavior were not tested. |
| Timezone/work-date boundaries | **PASS — pure unit tests** | Policy tests cover Asia/Kolkata date rollover and cutoff boundaries. These do not test PostgreSQL date/timestamp types or route response serialization. |

## 5. Existing API shapes and frontend expectations

**PASS — static contract inspection only.** The employee screens consume `/api/attendance/today` as a flat attendance record, `/history` as an array, and `/me` as an object containing `records`, `today`, `openRecord`, `policy`, and `stats`. Current route serializers retain those shapes (`routes/attendance.js:280–365,370–405,410–437`). The Owner overview remains an `{ employees, summary }` response (`routes/attendance.js:508+`). No API contract test, browser session, or backend/frontend runtime integration was run.

## 6. Biometric verification — BLOCKED; keep disabled

- `routes/attendance.js:1019–1038` fails closed unless both `BIOMETRIC_WEBHOOK_ENABLED=true` and `BIOMETRIC_GATEWAY_CONTRACT_VERIFIED=true`, a secret exists, and Redis replay storage is ready.
- `services/biometricWebhookAuth.js:7–29` signs `${timestamp}.${nonce}.${JSON.stringify(body)}`, checks timestamp freshness and nonce format, and claims nonce with Redis `SET NX`/expiry. The helper tests verify its own implementation, not a vendor protocol.
- No gateway contract/documentation or compatible fixture was found in the requested materials/repository. Exact raw-byte canonicalization, timestamp header units, device-to-company provisioning, key rotation, and gateway retry semantics remain unverified.

**Decision:** Do not enable or exercise the webhook. Obtain the vendor contract and test fixture first, then run only against isolated Redis and database services.

## 7. Request-time DDL — FAIL (confirmed source behavior)

`routes/reports.js:12–18` defines `ensureReportColumns()` with `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS working_hours ...` and `is_late ...`. `GET /api/reports/attendance` calls it at `routes/reports.js:81–86` before its report query. Thus an ordinary request can perform schema DDL when columns are missing. Other report handlers also call the helper. The endpoint was not called, and no DDL was executed. Moving this to a separately reviewed migration/initialization change is outside this verification task.

## 8. Targeted fixes and files changed

- **Targeted fixes made:** None. No source failure was safely confirmable through runtime integration, and schema repair/migration or request-time DDL changes require a separate reviewed change.
- **Files changed:** Added only `SMARTERP_ATTENDANCE_INTEGRATION_VERIFICATION_REPORT.md`.
- **Preserved work:** The two uncommitted frontend edits in `SmartERP-Frontend/app/employee/time-tracking/page.tsx` and `app/employee/time/page.tsx` predated this task and were not modified, staged, or discarded.

## 9. Verification boundaries and next safe step

- **Source checks:** Schema/migration/runtime SQL/RLS wiring and route/service logic inspected as documented above.
- **Unit tests:** 84 baseline tests and 22 focused tests passed; these are pure/helper/mock/source checks.
- **Isolated database tests:** **None run.** Blocked until the owner supplies/identifies the authoritative schema/migration baseline and a disposable test database with explicit test-only credentials, expected grants/RLS setup, and synthetic tenant fixtures.
- **Production verification:** **None.** No production credentials, database, APIs, or records were accessed.

After the baseline is provided, verify the database host/name is disposable before connecting; apply only the documented test schema/migrations there; inspect attendance and correction columns, grants/RLS, duplicate groups, and indexes read-only; then run the requested two-company, route-role, independent-connection race, correction rollback, leave ordering, scheduler recovery, and response-contract integration tests. Keep biometric verification blocked until vendor contract evidence is available. Do not add uniqueness constraints or reconcile records until duplicate preconditions and identity rules are reviewed.
