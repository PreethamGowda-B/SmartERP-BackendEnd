# SmartERP Attendance Remediation Report

## Scope and safety

Remediated the confirmed code-level findings in `SMARTERP_ATTENDANCE_VERIFICATION_REPORT.md`. Work was local only. No production API, database, migration, attendance record, commit, push, or deployment was used. Historical attendance rows were not bulk-edited or reconciled.

## Findings and remediation

### Priority 1 — Authorization and tenant isolation

- **HR analytics role guard — FIXED.** `routes/hr.js` now permits only Owner, Admin, and HR through a normalized explicit allow-list in `services/attendanceAccess.js`; missing company context is rejected. The existing response shape is preserved.
- **Attendance query isolation — FIXED IN CODE.** Added attendance row company predicates to the specified dashboard, reports, payroll, HR attendance summaries, command-center company scope, attendance report joins, AI summaries, and notification queries. Employee reminder lookup now verifies the employee belongs to the notification company. Super Admin command-center analytics retain their intentional global scope.
- **Work-date handling — FIXED IN CODE.** Attendance dashboard, HR analytics, command center, attendance reports, AI summaries, and reminder defaults now derive the date through `AttendancePolicy.localDate` with the company policy timezone. Attendance report date ranges use date-only boundaries based on that work date. Non-attendance report periods were left on their existing date calculation to preserve behavior.
- **Manual correction classification — FIXED.** The Owner attendance editor derives status and late state from policy even for incomplete punches and does not trust a submitted status. It clears saved working hours when a punch is incomplete.
- **Correction review atomicity — FIXED IN CODE.** HR attendance-correction review and attendance correction approval now lock and update the attendance and pending request in one transaction. Notification delivery remains after commit.

### Priority 2 — Attendance correctness

- **Approved leave after absence processing — FIXED FOR CURRENT WORK DATE.** If approved leave is found for a current-day absent row, processing changes only that current row to `leave`. If leave is approved before absence creation, no absent row is inserted. Older work dates are not rewritten.
- **Automatic clock-out retry — FIXED IN CODE.** The processor now ticks every minute, retains startup recovery and per-company/work-date advisory locks, and retries failed work on the next tick. The canonical helper determines the inclusive cutoff instant and persisted clock-out remains at the configured 19:00 cutoff even after a delayed tick. No browser-side automatic clock-out writer was found; browser controls submit only when the employee acts.
- **Biometric integration — FAIL-CLOSED / UNVERIFIED.** The route now requires both `BIOMETRIC_WEBHOOK_ENABLED=true` and `BIOMETRIC_GATEWAY_CONTRACT_VERIFIED=true`. The implementation report now documents the actual signed bytes: `${timestamp}.${nonce}.${JSON.stringify(body)}`. No gateway contract was supplied or verified, so there is no claim of compatible device integration. The endpoint should remain disabled.
- **Biometric clock-out boundary — FIXED IN CODE.** Biometric events at exactly the cutoff now use the same inclusive automatic-clock-out rule as manual punches and the scheduler.

### Priority 3 — Database safety

- **Schema mismatch — UNRESOLVED / NO SCHEMA CHANGE.** The verification report identifies tracked `schema.sql` attendance columns that differ from runtime attendance columns. The runtime schema was not inspected through a database connection. No baseline, migration, uniqueness constraint, or record cleanup was invented or applied.
- **Database duplicate protection — NOT VERIFIED.** Existing application-level advisory locks remain. No database uniqueness constraint was added because deployed schema and duplicate preconditions require a disposable, isolated database review first.

## UI updates in this task

- Owner Attendance now presents a compact policy summary with an on-demand “Manage policy” disclosure, so policy fields are not expanded each time the page opens. The page has a clearer live status header, manual refresh, and more readable responsive metric cards. Existing routes and data contracts remain unchanged.
- Employee Time & Shift Console retains the server-driven shift and attendance flow, clarifies the company timezone, counts half-days in present-day metrics, and calculates its on-time percentage from actual check-in rows instead of a fixed display value. The GPS copy no longer claims cryptographic location validation. The separate Employee Time screen uses Asia/Kolkata for today’s date and distinguishes half-day and leave badges.
- Source inspection found a biometric webhook handler and a `biometric_devices` lookup, but no Owner UI or backend management API for registering/configuring reader devices or keys. No fingerprint/card/sensor setup feature was added or represented as available.

## Files changed

- Backend routes/services: `routes/hr.js`, `routes/dashboard.js`, `routes/commandCenter.js`, `routes/reports.js`, `routes/payroll.js`, `routes/attendance.js`, `services/aiDataService.js`, `services/notificationRoutingService.js`, `services/attendancePolicyService.js`, `services/biometricWebhookAuth.js`, `services/attendanceAccess.js`, `jobs/dailyAttendanceProcessor.js`.
- Backend tests/docs: `tests/attendancePolicyService.test.js`, `tests/attendanceRemediation.test.js`, `SMARTERP_ATTENDANCE_IMPLEMENTATION_REPORT.md`.
- Frontend: `app/owner/attendance/page.tsx`, `app/employee/time-tracking/page.tsx`, `app/employee/time/page.tsx`.
- Added this report: `SMARTERP_ATTENDANCE_REMEDIATION_REPORT.md`.

## Tests and checks actually run

- `npm test` in `SmartERP-BackendEnd`: **84 passed, 0 failed**.
- `node --test tests/attendancePolicyService.test.js tests/biometricWebhookAuth.test.js tests/attendanceRemediation.test.js`: **22 passed, 0 failed**. Tests cover role allow-list, source-level company-predicate presence, date boundaries, leave before/after processing (using service mocks), delayed cutoff/idempotent retry (using service mocks), and opt-in/replay helper behavior.
- `node --check` on changed backend JavaScript files: **passed**.
- `npx tsc --noEmit --pretty false` in `SmartERP-Frontend`: **passed**.
- `git diff --check` in both repositories: **passed**.

## Outstanding risks and next safe verification

1. **Two-company isolation requires a disposable isolated database.** The automated predicate test is source-level only; it does not execute the routes against two tenants. Verify owner, personal, payroll, AI, dashboard, and notification results with two-company fixtures and the supported RLS configuration.
2. **Correction transactions require isolated route tests.** Test simultaneous review, database failure between writes, processed-row races, and response compatibility against the supported schema.
3. **Scheduler tests here are service mocks, not cron/database integration.** In a disposable database, verify a missed 19:00 tick, process restart recovery, repeated ticks, and transaction rollback/retry without duplicate attendance effects.
4. **Biometric gateway remains unverified.** Obtain the vendor’s canonical request bytes, signature headers, timestamp/nonce rules, and replay contract. Test against a real gateway-compatible fixture and isolated Redis/database before setting both enablement flags.
5. **Schema/uniqueness remain open.** Establish the supported schema baseline and inspect duplicate preconditions in a disposable isolated database. Only then consider a reviewed migration. Do not delete, merge, or rewrite historical/duplicate records without a separate reviewed reconciliation plan.
6. `/api/reports/attendance` currently invokes `ensureReportColumns()`, which issues `ALTER TABLE` statements. This endpoint was not called. Review that existing request-time DDL separately before using that route in any environment.

No production behavior is claimed as verified.
