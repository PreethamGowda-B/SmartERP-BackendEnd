# SmartERP Attendance Verification Report

**Verification date:** 2026-10-17
**Scope:** Read-only review of the implementation report, implementation plan, complete attendance audit, current committed backend/frontend source, and tracked SQL schema/migrations.
**Restrictions:** No code/config/schema/attendance edits, database connections, migrations, production APIs, commits, pushes, or deployments were performed. Only this verification report was created.

## Executive summary

The main Owner, Employee, and HR attendance screens read server attendance data, and the core attendance endpoints use `services/attendancePolicyService.js` for the approved defaults, IST work date, and punch calculations. Safe unit tests and static checks pass.

The implementation is **not fully verified against the plan**. The tracked `schema.sql` is incompatible with the runtime route column names and contains no `(user_id, date)` uniqueness constraint. The scheduler polls every five minutes, so the automatic row update can occur after 7:00 PM even though it records a 7:00 PM cutoff timestamp. Approved leave does not protect a previously created absent row. Several other attendance summary/report endpoints still use UTC/server-local dates or bypass the canonical service. The HR analytics endpoint lacks an attendance-specific role guard, the owner manual edit route can accept a caller-supplied status for incomplete records, and the biometric signature instructions do not match the code’s signed string. Production schema, RLS behavior, scheduled execution, and route-level concurrency remain unverified.

## Findings

### 1. Existing portal screens read the canonical server state — PASS (static code evidence)

| Portal/screen | Evidence |
|---|---|
| Owner Attendance | `SmartERP-Frontend/app/owner/attendance/page.tsx`: `fetchAttendanceOverview` calls `/api/attendance/overview` (lines 82–87); `fetchPolicy` calls `/api/attendance/policy` (94–99); save calls the owner policy endpoint (104–111); overview refreshes periodically/on focus (124–134). |
| Owner employee detail | `app/owner/attendance/[userId]/page.tsx:59` reads `/api/attendance/employee/:userId`; displayed timestamps are rendered in `Asia/Kolkata` (75–82). |
| Employee Dashboard | `app/employee/page.tsx:106–110` loads `/api/attendance/today` and `/history`; refreshes on interval/focus (146–154); the clock component uses `/policy` and the punch endpoints (`components/clock-in-out.tsx:55–75,102–125`). |
| Employee Time Tracking → Shift Control | `app/employee/time-tracking/page.tsx:95–118` reads `/today`, `/policy`, and `/history`; it refreshes on interval/focus (149–159), and punches through the attendance endpoints (179–218). |
| Employee `/employee/time` | `app/employee/time/page.tsx:45–67` reads `/api/attendance/me` and refreshes from the server. |
| HR Attendance | `app/hr/attendance/page.tsx:54–78` reads `/api/attendance/overview` and refreshes; the endpoint returns stored rows plus approved-leave information. |

These screens do not independently write automatic clock-out or assign the primary attendance status. This is static inspection only; browser-to-backend behavior and deployed API responses were not exercised.

### 2. Core policy defaults/calculations and IST work-date conversion — PASS (unit-test and source evidence)

`SmartERP-BackendEnd/services/attendancePolicyService.js:1–14` defines the approved 09:00 start/earliest clock-in, 19:00 shift end/automatic cutoff, 09:00 late threshold with zero grace, 13:00 half-day threshold, 11:00 clock-in cutoff, and `Asia/Kolkata`. `evaluateClockIn` enforces earliest/cutoff at second precision (`101–108`); `classifyStatus` handles the half-day and early-departure rules (`93–99`); `localDate` and `zonedDateTimeToUtc` handle IST dates/cutoffs (`39–70`). Manual routes, corrections, biometric actions, and the scheduler call these functions.

The focused unit tests cover the exact 09:00, 11:00, 13:00, and 19:00 boundaries, IST/UTC date rollover, and working-hours rounding. This proves the pure service behavior, not route wiring or deployed timezone configuration. The 13:00 clock-in half-day case is unreachable through a new punch because clock-in closes after 11:00; it remains reachable for correction/legacy data and an early checkout produces half-day. This rule relationship is documented in the implementation report.

### 3. Automatic clock-out runs on a five-minute polling schedule — FAIL (timing does not guarantee a 7:00 PM state change)

`jobs/dailyAttendanceProcessor.js:startDailyAttendanceProcessor` schedules `*/5 * * * *` in Asia/Kolkata (`47–59`). `processCompanyDate` stores the configured cutoff instant, 19:00, as the clock-out time after a run reaches/passes it (`attendancePolicyService.js:149–167`). Therefore, the saved timestamp is 19:00, but execution may not update the row until as late as 19:04:59. The UI polls at 30-second intervals, so it may also show the shift open until the server run completes and the next refresh happens.

**Impact:** The record’s historical time is correct, but “automatically clock out at 7:00 PM” is not guaranteed as an immediate state transition at 7:00 PM.

**Minimum fix/test:** Schedule an exact 19:00 IST run (with a durable retry/recovery mechanism) or adopt a sufficiently frequent/queue-based cutoff trigger. In an isolated integration test, assert both the recorded cutoff and the maximum state-update delay across process restart and delayed ticks.

### 4. Approved leave can still leave an absent attendance row — FAIL

`services/attendancePolicyService.js:168–180` checks approved leave only in the `else if (!record)` branch before creating an absent row. If an absent row already exists when leave becomes approved, the branch is skipped and the existing row is subsequently locked at `183–185`; its status remains `absent`. `GET /overview` derives `on_leave` separately and excludes leave from the summary absent count, but still returns the absent row (`routes/attendance.js:524–556`).

The current unit test `tests/attendancePolicyService.test.js` mocks approved leave only for an employee with no row, so it does not cover an existing absent row.

**Impact:** Approved leave can conflict with the saved attendance status/history and downstream reports even though the overview summary suppresses the absence count.

**Minimum fix/test:** Define a non-destructive status rule for a same-day absent row when leave is approved, then test both leave-approved-before-processing and leave-approved-after-absence-processing. Preserve historical records; any retroactive status adjustment must be limited to the appropriate unprocessed/current date and reviewed.

### 5. Core route tenant and role checks — PASS in source; runtime RLS NOT VERIFIED

- Employee clock-in/out require role `employee`, derive identity from the authenticated token, verify employee/company membership, and include the company in row lookups/updates (`routes/attendance.js:47–57,117–142,217–241`). Self-service history and correction requests also filter by authenticated user and company (`281–435,444–477`).
- Owner overview/detail/calendar and correction review enforce owner/admin (overview also HR) and company scope (`508–665,669–820`). Manual daily processing accepts only owner/admin, derives the company from the token, limits dates to today/yesterday, and calls the tenant-scoped service (`996–1029`). The service selects employees and rows with `company_id` predicates (`attendancePolicyService.js:151–156`).
- Biometric webhook has HMAC/timestamp/nonce replay checks and validates that the employee and device share a company (`routes/attendance.js:1035–1083`; `services/biometricWebhookAuth.js`). Device punches use company-scoped row reads and transaction locks (`1086–1117`).
- The HR request review route limits review roles and scopes the request/attendance record to the reviewer’s company (`routes/hr.js:168–206`).
- The tracked RLS policy files define company filters for `attendance` and `company_settings` (`migrations/rls_policies.sql:78–89,210–222`), and `middleware/authMiddleware.js` installs tenant context (`189–191`).

No route-level two-tenant tests or disposable-database RLS tests were run. Consequently, actual SQL role grants, RLS activation, ALS propagation through every path, and deployed tenant isolation are **NOT VERIFIED**.

### 6. Some attendance read/report queries lack canonical timezone or explicit row-company scoping — FAIL

- `routes/dashboard.js` computes the date using UTC `toISOString()` (`18`) and counts attendance for that date (`34–40`). Around IST midnight this can query the wrong company work date.
- `routes/hr.js:/analytics` uses database `CURRENT_DATE` for present/late counts (`52–53`) and counts only `present`/`arrived` as present, excluding canonical `late` and `half_day` statuses.
- `routes/commandCenter.js` uses `CURRENT_DATE` (`36–47`) and queries `clock_out_time IS NULL`, while the canonical attendance routes use `check_out_time`. Its error handler converts query failures to a zero count (`47`), potentially hiding clocked-in employees.
- `routes/reports.js:dateRangeFilter` uses the server’s local `Date` methods and serializes range endpoints to UTC (`37–54`). Owner and employee attendance reports use that filter (`80–116,382–414`) rather than `AttendancePolicy.localDate` and do not call the shared service. The owner report joins attendance on `user_id` only (`94`) without `a.company_id` in the join; the personal report filters by user id only (`399–413`). RLS may narrow these reads, but explicit query-level tenant predicates are absent.
- `routes/attendance.js:/report` scopes users to the owner’s company but joins `attendance` only by user ID (`routes/attendance.js:913–925`), rather than also joining `a.company_id`.
- Additional direct readers found by source search also bypass the canonical service or omit an explicit attendance-company predicate: `routes/dashboard.js:/owner/recent-activity` joins by user id and filters only `users.company_id` (`112–128`); `services/aiDataService.js` uses `CURRENT_DATE` and joins by user id only in its attendance overview/anomaly queries (`63–79,245–260`); `routes/reports.js` employee attendance calculations filter on user id without `a.company_id` (`222–231`); `routes/payroll.js` calculates attendance by employee id without `company_id` (`78–91`); and `services/notificationRoutingService.js` checks attendance by user/date without a company predicate (`126–133,165–177`). Some callers likely depend on user IDs being globally unique and/or RLS. This is not evidence that deployed RLS is ineffective; it is a gap against explicit tenant-scoped query design and needs isolated two-tenant verification.

**Impact:** Summary/report dates and status totals can disagree with the core attendance screens; the command-center query may silently return zero. Some report reads rely on RLS or globally unique user identity instead of explicit row-level company joins.

**Minimum fix/test:** Route all attendance date-range/status consumers through the canonical policy service, use company-local date boundaries, and add company predicates to every attendance join/query. Add fixed-UTC-clock tests around IST midnight and two-company fixtures for owner/personal reports, payroll summaries, AI summaries, dashboard activity, and notifications. Do not invoke `/api/reports/attendance` during this review: `ensureReportColumns()` can issue DDL at request time.

### 6a. HR analytics lacks a role restriction — FAIL

`routes/hr.js:38–55` attaches only `authenticateToken` to `GET /api/hr/analytics`; it does not require owner, admin, or HR role. The handler returns company-wide attendance counts plus pending requests, recruitment, and asset counts using the authenticated company ID.

**Impact:** Any authenticated user in the company, including an employee, can request HR-level aggregate data. Company scope is present, but role authorization is not.

**Minimum fix/test:** Add an explicit allow-list for owner/admin/HR roles before querying. Test employee/customer denial and owner/admin/HR success.

### 7. Application advisory locks exist, but database uniqueness is absent in tracked schema — FAIL for the combined requirement; deployed constraint NOT VERIFIED

Manual and biometric clock-in/out, policy updates, and scheduler processing use transaction-scoped PostgreSQL advisory locks (`routes/attendance.js:95–98,127–134,227–233,1086–1107`; `attendancePolicyService.js:139–156`; `jobs/dailyAttendanceProcessor.js:6–13`). These serialize code paths that take the same lock. The focused tests do not exercise concurrent route calls or independent database sessions.

Read-only schema inspection found:

- `schema.sql:127–140` defines `attendance` with `clock_in`/`clock_out`, not runtime `check_in_time`/`check_out_time`; it has no `is_late`, `is_processed`, or auto-clock-out fields and no unique `(user_id, date)` constraint.
- `migrations/001_hardening_indexes_and_migration.sql:45–47` creates ordinary indexes only. `migrations/011_standardize_uuid_and_core_rls.sql` and `migrations/rls_policies.sql` add RLS, not the missing attendance uniqueness constraint.
- No tracked SQL definition for a unique attendance key was found.

`SELECT ... FOR UPDATE` cannot lock a missing row. The advisory lock protects updated application routes only; legacy writers or other routes that do not acquire it can still insert duplicates. The actual deployed table/constraints were not queried, as requested.

**Minimum fix/test:** Before any migration, inspect a disposable database created from the real supported schema and report duplicate `(company_id,user_id,date)` groups read-only. Resolve any duplicates through a reviewed, non-destructive reconciliation plan, then add an appropriate company-aware unique constraint/index. Test two independent connections racing clock-in and scheduler/manual processing. First resolve the `schema.sql` versus runtime-column mismatch through an approved migration/schema baseline.

### 8. Correction updates are company-scoped but are not atomic — FAIL

`routes/attendance.js:/corrections/:id/approve` updates the attendance row first (`705–720`) and only afterward updates the correction to `approved` (`724–730`); these statements are not in one transaction. A concurrent reviewer or a failure in the second update can leave attendance changed while the request remains pending or the API returns a conflict. `routes/hr.js:/requests/:id/review` similarly updates attendance before changing the request status (`202–218`) without one transaction.

**Impact:** Correction state and attendance state can diverge despite tenant checks and `is_processed` guards.

**Minimum fix/test:** Make the attendance update and review-status transition one transaction with a row lock and conditional `status='pending'`; test duplicate simultaneous review, simulated failure between writes, and processed-row races in an isolated database.

### 8a. Owner manual edit can bypass canonical status classification — FAIL

`routes/attendance.js:/attendance/:id` initializes `canonicalStatus` from the request body and recomputes policy status only when both `nextIn` and `nextOut` exist (`827–887`). For an incomplete record (for example, check-in only), a caller with owner/admin permission can submit a status inconsistent with the 13:00 half-day or late rules; if no status is supplied, a stale saved status can remain.

**Impact:** The manual correction path can diverge from the shared policy service even though all ordinary punches use it.

**Minimum fix/test:** Derive status/late state through `classifyStatus` whenever a check-in exists, ignore/reject caller-supplied canonical status, and test check-in-only cases at 09:00, 09:01, 11:00, and 13:00, plus clearing timestamps.

### 9. Policy update restrictions — PASS in source; effective-date workflow NOT VERIFIED

`routes/attendance.js:/policy` permits writes only for role `owner` (`86–91`), serializes against punch/scheduler work for the same company/date, and rejects changed policy after any attendance row exists for today (`93–100`). `saveCompanyPolicy` uses the existing `(company_id, setting_key)` conflict key (`attendancePolicyService.js:124–133`).

The UI displays API errors, but no effective-dated policy versioning exists. After today has attendance, the owner must wait until a date with no attendance record before changing policy; changing values before the shift begins can still be blocked if an absent or other row already exists. Runtime key uniqueness, RLS, UI behavior, and policy changes around midnight are not database-tested.

**Minimum verification:** On a disposable database, prove employee/admin writes are denied, owner changes are blocked once a row exists, unchanged saves are harmless, and policy changes take effect only for the intended work date.

### 10. Scheduler recovery and tenant processing — PARTIAL PASS; runtime recovery NOT VERIFIED

`server.js:1043–1053` starts the scheduler only in the designated primary worker; `jobs/dailyAttendanceProcessor.js:47–59` also performs a startup scan. The scheduler processes each company separately, under a run advisory lock and transaction, and considers only yesterday and today (`6–44`). `processCompanyDate` does not write before the configured cutoff (`149–152`) and skips historical processing if the policy was changed after the target date (`143–147`).

This supports bounded recovery in code, not recovery guarantees. No scheduler crash/restart, multiple-primary, partial-failure, retry, or real cron execution test was run. A worker crash after processing one company stops that scan; the next five-minute invocation is expected to retry later companies.

**Minimum verification:** Simulate a missed cutoff, restart, failure between companies, two application primaries, and repeated ticks using a disposable database and controlled clock. Confirm one effect per company/date and no premature processing.

### 11. Notifications and biometric notification coverage — PARTIAL PASS / NOT VERIFIED

Manual clock-in sends owner notification and late/half-day employee notifications after persistence (`routes/attendance.js:153–214`); manual clock-out notifies owners (`247–274`). Scheduler auto-clockout sends no notification, which is explicitly disclosed in `SMARTERP_ATTENDANCE_IMPLEMENTATION_REPORT.md` under limitations. The biometric route returns after writing and does not send the equivalent notifications (`1086–1120`).

This matches the report’s stated manual-notification behavior, but there is no test proving notification routing/tenant recipients for attendance events, and biometric/scheduler notification expectations remain unresolved.

**Minimum verification:** In isolated route tests, assert notification recipients/company and no duplicate notification on idempotent retries. Owner must decide whether auto-clockout and biometric events require notifications before treating notification parity as complete.

### 12. Offline punches remain pending and are not replayed — PASS (static code evidence)

`app/employee/time-tracking/page.tsx:326–329` labels offline punches as device-local pending, says they do not change attendance, and says they will not be replayed. Pending items disable clock actions (`254–256,401–403`). No backdated client timestamp is sent through the API. No offline browser end-to-end test was run.

### 13. Biometric signature/replay guard — FAIL (protocol documentation mismatch); helper unit tests PASS; gateway/route integration NOT VERIFIED

`services/biometricWebhookAuth.js:13–15` computes HMAC over `${timestamp}.${nonce}.${JSON.stringify(body)}`. However, `SMARTERP_ATTENDANCE_IMPLEMENTATION_REPORT.md:44` says the signature is over `JSON.stringify(req.body)` without the timestamp/nonce prefix. The code validates the HMAC, timestamp, nonce shape, and Redis `SET NX EX` claim; `routes/attendance.js:1035–1067` fails closed when the secret or Redis is missing and checks replay before processing. The helper suite passes valid signature, tamper, stale timestamp, and replay cases. No real gateway signature, Redis integration, tenant RLS, or biometric route test was run.

**Impact:** A gateway configured from the implementation report’s protocol description will produce signatures rejected by the endpoint. The actual required format is the timestamp, a period, the nonce, a period, then compact `JSON.stringify(body)` bytes.

**Minimum fix/test:** Correct the integration contract documentation or code to one agreed canonical payload, then test an actual gateway-compatible signature against the route in an isolated environment.

### 13a. Biometric clock-out differs at the exact cutoff — FAIL

Manual clock-out treats `now >= cutoff` as automatic (`routes/attendance.js:232–235`), while biometric clock-out uses `actionTime > cutoff` (`1111–1114`). At exactly 19:00 IST, biometric clock-out is persisted with `is_auto_clocked_out = false` even though the scheduler cutoff is 19:00.

**Impact:** The auto-clock-out marker and method differ by entry path at the exact boundary.

**Minimum fix/test:** Align the inclusive comparison and add a route-level test for biometric events exactly at 19:00 and one second after.

**Minimum verification:** Confirm vendor signing exactly matches the canonical string documented in the implementation report and run signed requests against an isolated route/Redis fixture. Do not enable a live device until that succeeds.

## Checks run

- `npm test` in BackendEnd: **84 passed**. This package script runs `tests/unit.test.js` only; it is not DB-backed.
- `node --test tests/attendancePolicyService.test.js tests/biometricWebhookAuth.test.js`: **13 passed**. These are pure/service mock tests, not route or database integration tests.
- `node --check` on attendance route, HR route, policy/auth services, scheduler, attendance service, and gatekeeper: passed.
- `npx tsc --noEmit --pretty false` in Frontend: passed.
- SQL/schema inspection was read-only. No test invoking migrations, `DATABASE_URL`, report endpoints, or database writes was run.

## Claims by evidence level

**Supported by current code:** Core screen/API wiring; fixed default policy functions; IST date conversion; company-scoped main punch and scheduler queries; owner-only policy writes; owner/admin manual processing restricted to caller company and today/yesterday; biometric helper validation; offline pending/no-replay behavior; startup and prior-day recovery code.

**Supported by safe tests:** Pure policy boundaries, IST rollover, working-hours calculation, mock tenant-scoped processor path, mock approved-leave-before-absence case, policy storage key, HMAC validation, Redis nonce replay helper; existing 84-test unit suite; JS syntax and frontend typecheck.

**Failures established by source inspection:** Five-minute (not exact-time) scheduler trigger; approved leave does not correct a pre-existing absent row; parallel summary/report APIs use UTC/server/database-local date logic and/or different attendance columns/statuses; incomplete explicit company joins in attendance reports; correction and review status writes are non-atomic; tracked attendance schema has incompatible columns and no unique user/date constraint.

**Not verified:** Deployed attendance schema, actual unique constraints, runtime RLS and `smarterp_app` grants, route-level concurrency, tenant isolation under two DB sessions, actual cron/recovery behavior, live notification delivery, biometric gateway compatibility, and all production behavior.

## Required next gate

Do not treat this implementation as production-verified. First resolve the schema/runtime mismatch and uniqueness plan. Then, on a disposable database only, add route-level tests for tenant/role isolation, duplicate punches across independent connections, existing-absent-row leave approval, atomic corrections, IST date boundaries in all reports/summaries, scheduler exactness/recovery, and notification routing. Production behavior remains outside this report’s evidence.
