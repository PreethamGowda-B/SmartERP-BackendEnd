# SmartERP Complete Attendance System Audit

**Audit date:** 2026-10-17
**Scope:** Static source inspection of the current Frontend and BackendEnd repositories, plus safe local unit tests.
**Restrictions observed:** Audit only. No source files, migrations, configuration, or attendance records were modified. No production API/database was called. No commit, push, or deployment was performed.

## 1. Executive summary

The attendance feature has a real PostgreSQL-backed flow for clock-in/out, an owner overview and employee history, correction requests, and a scheduled 7:00 PM IST processor. Several related screens and backend paths implement separate versions of the same rules, however, and those rules do not agree.

Three reported problem categories have identifiable code-level causes:

1. **The 5:30-hour clock-in notification difference is explained by an unzoned server-local formatter.** `routes/attendance.js` constructs the employee clock-in notification with `clockInTime.toLocaleTimeString()` without a timezone. If the backend process runs in UTC, an actual 4:37 PM IST instant renders as 11:07 AM UTC. The owner notification uses a different IST-shifted date object. The actual production timestamp and process timezone were not available, so the exact historical record was not verified.
2. **Clock-in eligibility differs between the Employee Dashboard and Time Tracking.** Dashboard widget `components/clock-in-out.tsx` blocks clock-in after 11:00 AM using browser time. `/employee/time-tracking` calls the same backend clock-in route without that cutoff. The backend permits clock-ins after 1:00 PM as `half_day` and at/after 7:00 PM as `overtime`; it does not enforce the 11:00 AM cutoff. This explains why one screen can say the window is closed while another succeeds.
3. **The 7:00 PM automatic clock-out exists, but multiple implementation details can make it unreliable or inconsistent.** A server cron is scheduled for 19:00 Asia/Kolkata on the designated primary worker. The browser widget also attempts clock-out at 19:00 based on the client’s local timezone and only while that page is open. The browser effect can make repeated requests while the first is pending. The scheduled job is registered at startup, but a registration log does not prove that the task ran successfully at the cutoff. Date handling also mixes IST and UTC day boundaries.

The owner roster is read-only in its current UI; editing, correction approval, and direct attendance editing APIs exist but are not surfaced there. No actual attendance table creation migration was found in the checked-in migrations; the route code relies on an existing schema. Break tracking and shift-aware rule evaluation are absent from the attendance calculation paths inspected.

## 2. Method and confidence

I inspected the frontend routes/components, `routes/attendance.js`, the daily processor, gatekeeper middleware, relevant HR/payroll/report paths, and tracked migrations. `tests/unit.test.js` was run locally (84 passed, 0 failed). Its attendance tests exercise standalone copies of status/hour calculations; they do not call the route handlers, query a database, or test timezone/date behavior, cron execution, notification rendering, or tenant isolation.

All reported root causes below are source-confirmed. Historical record values, the actual runtime timezone, cron execution at a specific production cutoff, and live tenant isolation were not verified because production/runtime access was not used.

## 3. Owner Portal inventory

### Attendance roster — `/owner/attendance`

Navigation is declared in `SmartERP-Frontend/components/owner-sidebar.tsx` as **Attendance** (`/owner/attendance`, line 111). The page is `SmartERP-Frontend/app/owner/attendance/page.tsx`.

The page fetches `GET /api/attendance/overview` once when an authenticated user is present (lines 58–75). It shows four summary cards:

- **Total Staff:** `summary.total`, the number of employee rows returned by the endpoint.
- **Present:** employees with a non-null `check_in_time`; the backend count includes a checked-in employee regardless of final status.
- **Absent:** employees with no `check_in_time`, including people on leave because the overview does not join approved leave.
- **Late Arrivals:** employees with `is_late = true`.

The roster table shows employee name/email, check-in, check-out, hours, status, and a separate Late badge. It has built-in table search/sorting and clicking a row opens `/owner/attendance/[userId]` (page lines 211–290). There is no explicit refresh control or polling in this page; it fetches on mount/user change. Status rendering distinguishes missing check-in (Absent), open session (Checked In), `present`, `half_day`, and `absent`; `late` is displayed in the separate Late indicator while the primary badge falls through to Unknown.

An Export action requests `GET /api/attendance/report?month=…&year=…` and flattens the records (page lines 111–162). The roster page itself has no attendance correction approval, direct edit, shift management, or manual missed-punch action.

### Employee detail — `/owner/attendance/[userId]`

The detail page is `SmartERP-Frontend/app/owner/attendance/[userId]/page.tsx`. It fetches `GET /api/attendance/employee/:userId?month=…&year=…` (lines 54–71), provides month/year selectors and summary values (total days, present, absent, half-days, total hours, late days), and switches between list and calendar views. Selecting a calendar day opens the `DayDetail` component. This screen is also read-only; no edit/correction actions are present in the inspected page.

### HR attendance mirror — `/hr/attendance`

`SmartERP-Frontend/app/hr/attendance/page.tsx` also calls `GET /api/attendance/overview`, with summary cards and an export of the current overview. It is a current-day roster, not an independent HR attendance data source. The HR role is permitted by that backend endpoint. The HR page does not show edit or correction approval actions.

### Owner/HR backend authorization and queries

The endpoint inventory is in Section 5. The overview endpoint permits `owner`, `admin`, and `hr`, then filters employee rows to the authenticated company. Employee detail/calendar/report are owner/admin-only and check that the requested employee belongs to the caller’s company. Manual edit and correction approval/rejection are owner/admin-only and use attendance-company scoping in their mutation/lookups.

## 4. Employee Portal inventory

### Main Employee Dashboard — `/employee`

`SmartERP-Frontend/app/employee/page.tsx` fetches `GET /api/attendance/today` and `/api/attendance/history` as part of dashboard stats (lines 108–109) and passes the current record into `components/clock-in-out.tsx` (line 367). The widget exposes clock-in/out buttons, local clock-in eligibility feedback, GPS display, and auto-clock-out badges. Its button handler calls the same attendance POST routes as Time Tracking.

The widget’s rule is browser-local and coded in `components/clock-in-out.tsx` lines 24–45: before 09:00 is early, 09:00–11:00 is on-time/late, and after 11:00 it says the clock-in window is closed and disables the button (line 213). It does not derive this eligibility from the backend.

### Shift Control — `/employee/time-tracking`

Navigation is `SmartERP-Frontend/components/employee-sidebar.tsx` line 66. The page is `SmartERP-Frontend/app/employee/time-tracking/page.tsx`.

On mount it fetches today from `GET /api/attendance/today` and month history from `GET /api/attendance/history?month=…&year=…` (lines 85–114). It shows a live elapsed timer, clock-in/out controls, status and timestamp cards, working hours, late/auto-clock-out indicators, summary metrics, and a monthly/recent attendance history. It does not use the Dashboard widget’s 11:00 AM eligibility check. Its clock-in handler posts directly to `/api/attendance/clock-in` (lines 151–188), and clock-out posts to `/api/attendance/clock-out` (lines 191–233). The page fetches attendance on mount and after its own actions; it has no periodic refetch for a server-side automatic clock-out.

Offline actions are queued in browser IndexedDB (`SmartERP-Frontend/lib/db.ts`) and replayed when the browser emits `online` (time-tracking page lines 117–143). The queued record’s saved timestamp is not sent to the backend on replay; the backend records its own current time. Replaying an old action therefore does not preserve the actual offline punch time. If the browser closes before connectivity returns, the queue persists locally, but no server-side reconciliation occurs until that client runs the page again.

### Additional time page — `/employee/time`

`SmartERP-Frontend/app/employee/time/page.tsx` uses `SmartClockInOut` plus `GET /api/attendance/me` for history/stats (lines 5–6, 41–66, 151). This is another attendance presentation and another client-side 7 PM auto-clock-out trigger (`components/smart-clock-in-out.tsx`, lines 102–111). It runs only while that page is mounted and checks the browser’s local `getHours()` against 19. The primary shift page `/employee/time-tracking` does not mount this component.

### Employee reports

`SmartERP-Frontend/app/employee/reports/page.tsx` requests `/api/reports/my-attendance` and displays present/absent/half-day/late/hour metrics and history. This is a reporting view over the same attendance table, not a separate correction or shift system.

### Breaks, shifts, overnight work, and overtime

No break start/end or break-duration handling was found in the inspected attendance route/service/portal code. `hr_roster_shifts` is declared in `migrations/hr_master_backbone_schema.sql` (lines 61–70) with shift type, start/end, and effective date, but the attendance routes and daily processor inspected do not query it. Operational rules are hardcoded to 09:00–19:00 IST. The route recognizes status `overtime` for clock-in at/after 19:00, but the Dashboard widget closes its clock-in window after 11:00, and the server cutoff processor has already run for that day. Overnight shift/date boundary behavior is not implemented as a shift-aware rule in these paths.

## 5. API, services, notifications, and data flow

The router is mounted at `v1Router.use("/attendance", require("./routes/attendance"))` in `SmartERP-BackendEnd/server.js` line 861 and exposed under the API version prefix. Frontend calls use `/api/attendance/...`.

| Endpoint | Purpose and behavior | Authorization/scope seen in source |
|---|---|---|
| `POST /api/attendance/clock-in` | Uses server `new Date()`, calculates provisional status, inserts/upserts attendance, sends owner notification and employee late/half-day notification. | `authenticateToken`; uses user from token and token company for insert. No explicit employee-only role check. |
| `POST /api/attendance/clock-out` | Finds today’s row, calculates elapsed hours/status, saves checkout and sends owner notification. | `authenticateToken`; user from token. No explicit employee-only role check. |
| `GET /api/attendance/me` | Returns today/open record, last 60 days, and current-month stats. | `authenticateToken`; queries by token user ID. `companyId` is read but not used in these queries. |
| `GET /api/attendance/today` | Returns a matching today row or an empty shape; compares IST, UTC, and database current date. | `authenticateToken`; user ID scoped. |
| `GET /api/attendance/history` | Returns up to 100 of the authenticated user’s records, optionally filtered by month/year. | `authenticateToken`; user ID scoped. |
| `POST /api/attendance/corrections` | Employee requests corrected in/out timestamps and reason; creates correction row and notifies owners. | `authenticateToken`; verifies record belongs to token user and is not processed. |
| `GET /api/attendance/overview` | Current-day employee roster and total/present/absent/late counts. | Owner/admin/HR; employee rows filtered by token company. |
| `GET /api/attendance/employee/:userId` | Monthly detail and totals. | Owner/admin; verifies user company membership. |
| `GET /api/attendance/calendar/:userId` | Monthly calendar rows. | Owner/admin; verifies user company membership. |
| `PATCH /api/attendance/corrections/:id/approve` | Applies requested timestamps, computes hours/status, marks correction approved, notifies employee. | Owner/admin; joins correction to company-scoped attendance. |
| `PATCH /api/attendance/corrections/:id/reject` | Marks correction rejected and notifies employee. | Owner/admin; joins correction to company-scoped attendance. |
| `PATCH /api/attendance/:id` | Owner edit of check-in/out, status and notes; marks manual/edited-by. | Owner/admin; checks company and refuses processed records. |
| `GET /api/attendance/report` | Monthly owner report/export grouped by employee. | Owner/admin; users filtered by token company. |
| `POST /api/attendance/process-daily` | Manually auto-clocks out, marks absent, then locks all records for supplied/current date. | Owner/admin, but the SQL has no caller-company filter; see security finding. |
| `POST /api/attendance/biometric/webhook` | Biometric clock-in/out by registered device ID. | No `authenticateToken` middleware; verifies active device and same-company employee, but no request signature/device secret check appears in this handler. |

### Data flow

```mermaid
sequenceDiagram
    participant E as Employee Portal
    participant API as /api/attendance routes
    participant DB as PostgreSQL attendance
    participant N as Notification helper
    participant O as Owner Portal
    E->>API: POST clock-in or clock-out
    API->>DB: Read and insert/update own attendance row
    API->>N: Owner notification; employee late/half-day notification on clock-in
    API-->>E: Attendance row/status
    E->>API: GET today/history on mount or after local action
    O->>API: GET overview/report/detail
    API->>DB: Company-scoped owner roster/report queries
    API-->>O: Summary and attendance records
    Note over API,DB: 19:00 Asia/Kolkata cron also updates rows, marks absences, and locks records
```

The owner screen does not subscribe to attendance events or poll in the inspected page. The worker writes directly to the shared database; the page sees changes on a new fetch/remount/manual browser refresh.

## 6. Stored data and relationships

No checked-in migration found in the searched migrations that creates the core `attendance` table or `attendance_corrections`. Their live table definitions therefore cannot be certified from this repository snapshot. The following fields are evidenced by SQL use in `routes/attendance.js` and processor queries:

- **`attendance`:** `id`, `user_id`, `company_id`, `date`, `check_in_time`, `check_out_time`, `working_hours`, `status`, `is_late`, `is_auto_clocked_out`, `is_processed`, `processed_at`, `is_manual`, `edited_by`, `notes`, `clock_in_method`, `clock_out_method`, `biometric_device_id`, `created_at`, `updated_at`.
- **`attendance_corrections`:** `id`, `attendance_id`, `user_id`, `requested_check_in`, `requested_check_out`, `reason`, `status`, `reviewed_by`, `reviewed_at`, `rejection_reason`, `created_at` (fields referenced by the correction endpoints).
- **`hr_roster_shifts`:** `company_id`, `user_id`, `shift_type`, `start_time`, `end_time`, `effective_date`, `created_at`; this table is present in `migrations/hr_master_backbone_schema.sql` but is not consumed by the inspected attendance logic.
- **`hr_employee_requests`:** generic leave/correction/etc. request table in the same migration. `routes/hr.js` also has a legacy `attendance_correction` approval branch that updates status and `is_late`, distinct from `attendance_corrections` and without applying requested timestamps.

`migrations/001_hardening_indexes_and_migration.sql` adds indexes on attendance `user_id` and `company_id`. Clock-in uses `ON CONFLICT (user_id, date)`; no matching unique-constraint creation was found in the checked-in migration files, so the required constraint’s existence is unverified. Without it, the upsert cannot provide concurrency safety and may error. The database’s actual constraints, indexes, types, and historical duplicate sessions require a read-only schema inspection in an isolated authorized environment.

Attendance row IDs link correction requests via `attendance_id`; user/company IDs tie records to workforce and tenant scope. Payroll generation reads attendance totals for an employee/month and stores present, absent, half-day, and total hours in payroll; source comments say these are recorded for reference, not used to prorate salary (`routes/payroll.js` lines 71–128).

## 7. Existing business rules and calculations

The documented rules are hardcoded in `routes/attendance.js` helper functions and comments:

- Shift expectation: **09:00–19:00 Asia/Kolkata**.
- Before 09:00: present/on time.
- 09:01 through 12:59: late.
- At/after 13:00 and before 19:00: half day.
- At/after 19:00: backend provisional status `overtime` (comments describe this as allowed for CNC emergency repairs).
- A manual checkout before 19:00 is classified half-day, except after-13:00 is already half-day; a 19:00 or later checkout avoids the early-out classification.
- `calculateWorkingHours` subtracts timestamps and rounds to 2 decimals. It does not subtract breaks.
- The scheduled auto-checkout computes elapsed hours to 19:00 but does not round them. Its status uses check-in time (half-day after 13:00, late after 09:00, otherwise present), not the manual endpoint’s early-checkout rule.
- The manual `/process-daily` endpoint uses a different status rule: at least 8 hours means present, less than 8 means half-day.
- The recurring payroll logic stores attendance totals as reference and does not currently prorate salary based on attendance.
- No late grace period derived from configuration, approved leave exclusion from absentees, holiday calendar, rest breaks, configurable shift, overnight-shift boundary handling, overtime-hours calculation, or DST logic was found in the inspected paths.

There are at least three time sources: browser local time in the Dashboard widget and `SmartClockInOut`, server `Date`/local formatting in routes, and explicit IST date logic in the scheduled processor. A 9-to-7 shift is fixed in code rather than driven by `hr_roster_shifts`.

## 8. Critical reported bugs

### A. Clock-in notification shows 11:07 AM instead of about 4:37 PM

**Confirmed implementation cause:** `routes/attendance.js` captures `clockInTime = new Date()` and persists that timestamp. For the employee late/half-day notification it formats `clockInTime.toLocaleTimeString()` without a `timeZone` option (clock-in handler around lines 101–226). The owner notification separately formats an IST-shifted helper date. On a UTC process, a timestamp corresponding to 16:37 IST formats as 11:07 UTC; the five-and-a-half-hour discrepancy in the report matches this behavior.

**Classification:** Source-confirmed formatter bug; production row and exact host timezone unverified. Backend status classification uses `getISTTime` and is based on server instant rather than the notification’s displayed text, so a correctly classified half-day at 16:37 IST is consistent with the notification saying 11:07 AM UTC.

**Other display considerations:** The employee UI generally formats timestamp values in the browser’s local timezone; it does not consistently pass `Asia/Kolkata`. If the browser is not configured to IST, its displayed time can also differ from the business timezone.

### B. Dashboard says clock-in is closed but Shift Control accepts it

**Confirmed root cause:** `components/clock-in-out.tsx` blocks new punches after 11:00 AM using browser `getHours()`/`getMinutes()`. `app/employee/time-tracking/page.tsx` uses its own handler and sends `POST /api/attendance/clock-in` without enforcing that window. `routes/attendance.js` does not reject a request after 11:00; it sets `half_day` for 13:00–18:59 and `overtime` from 19:00.

**Authoritative rule:** There is no single authoritative eligibility rule today. Backend persistence accepts the request and classifies it; the Dashboard button is only a frontend restriction. Thus a successful 4:37 PM Shift Control punch is expected from the current implementation, even while Dashboard says no.

### C. Clock-out and working-hours inconsistency

**Confirmed implementations and risks:**

- Server cron: `jobs/dailyAttendanceProcessor.js` schedules `0 19 * * *` with timezone `Asia/Kolkata`, and startup invokes it only on the `IS_PRIMARY_WORKER=true` process (`server.js` lines 1027, 1043–1053). It auto-clocks out eligible rows, marks absent employees, and locks all attendance rows for the day.
- Deployment startup log in the user’s earlier pasted logs says the daily processor was scheduled. That confirms registration at that startup only; it does not prove the 19:00 run or the success of its SQL.
- `SmartClockInOut` also sends a clock-out when client-local hour reaches 19, but only while `/employee/time` is mounted. The effect does not guard against a request already in progress; while `activeRecord` remains set, repeated timer ticks can invoke it again. Browser timezone can differ from IST.
- `/employee/time-tracking` does not run its own 19:00 clock-out; after the server job changes the database, its displayed state remains stale until another fetch/remount/refresh.
- `POST /clock-out`, `/me`, and parts of the gatekeeper use UTC date strings, while clock-in and `GET /today` also consider IST dates. Around the India midnight boundary, a valid same-IST-day record can be looked up under a different UTC calendar date.
- Manual clock-out status, scheduled processor status, and manual daily processing status differ. Working hours are elapsed wall-clock time with no break subtraction.
- The scheduled processor marks rows `is_processed=true` immediately after auto-clockout. Clock-in code contains a resume-after-auto-clockout branch but does not clear `is_processed`; it only clears checkout and the auto-clockout flag. This may leave a resumed row locked against owner edits/correction requests.
- The cron has no explicit catch-up-on-startup path. If the designated worker is unavailable at 19:00, the code shown does not replay the missed cutoff when it starts later.

**Unverified:** Whether the production service had exactly one primary worker at the cutoff, whether cron ran at a particular date/time, whether the SQL changed rows, and whether any row was then modified again. The provided log excerpt is startup output, not cutoff execution output.

## 9. Notifications and integrations

- Clock-in sends an owner/company notification for every accepted clock-in. It sends an employee notification only for late or half-day; regular present and overtime do not produce an employee clock-in notification in this handler.
- Manual clock-out sends an owner notification with hours/status. The scheduled processor logs successful auto-clockout counts but does not send per-employee or owner success notifications. It sends a failure alert if the processor throws.
- Correction requests notify owners; approval/rejection notify the employee.
- Attendance feeds HR dashboard counts and reports; payroll snapshots store attendance days/hours. The main payroll route explicitly does not prorate salary.
- `requireClockIn` gates field operations (jobs accept/decline/progress, proof-of-work, work requests) by finding a same-user open attendance row. It uses UTC date in its primary lookup and a broad fallback query after errors.
- Biometric flow accepts `clock_in` or `clock_out`, resolves employee and device, and checks same-company membership. The webhook has no authentication middleware or visible signature/secret check; knowledge of an active `device_id` appears sufficient to reach the punch logic.

## 10. Security and tenant isolation findings

### Positive controls found

- Employee history and `me` endpoints constrain by authenticated user ID.
- Owner overview filters employees by the caller company; employee detail/calendar verify company membership before querying records.
- Correction approval/rejection join through the attendance row and company ID. Direct manual edit checks company ID and denies edits to processed records.
- The attendance RLS policies in `migrations/011_standardize_uuid_and_core_rls.sql` and `migrations/rls_policies.sql` constrain rows to `app.current_company_id` or explicit bypass/admin context. The latter uses `FORCE ROW LEVEL SECURITY`.

### Risks requiring remediation review

1. **Cross-company daily mutation endpoint:** `POST /api/attendance/process-daily` is callable by any owner/admin and its UPDATE/INSERT/lock queries filter by date but do not filter `company_id`. A company owner can therefore invoke a global daily run for a chosen date, potentially modifying/locking attendance records outside that owner’s company (unless another layer blocks the request). No runtime attempt was made.
2. **Attendance write routes lack role restriction:** clock-in/out have authentication but no employee-role check. They derive the target user ID from the token, so this is not an arbitrary user-ID mutation in these handlers, but a customer or other authenticated role could create/update their own attendance row if database/schema policy permits it.
3. **Unauthenticated biometric webhook:** device/company matching is checked, but the handler shows no signed request validation or device credential. Device ID should not be treated as proof of possession unless it is secret and authenticated by infrastructure not present in this repository.
4. **Inconsistent company scoping:** several self endpoints filter only by `user_id`, relying on the user's immutable ID and RLS. The correction request lookup does the same before inserting correction data. RLS should remain enabled and request ALS tenant context must be verified for every API connection.
5. **Global RLS bypass exists by design for jobs/system:** scheduled processor explicitly uses `storage.run({ bypassRls: true })`. This is necessary for a cross-company system job but increases the importance of validating its date, intended global scope, idempotence, and worker uniqueness.
6. **Potential missing unique constraint:** clock-in and biometric use `ON CONFLICT (user_id,date)`, but a corresponding unique constraint is not visible in checked-in migrations. Verify actual database schema; without the constraint, concurrency protection is absent and these statements may fail.

Customer Portal has no attendance UI/API flow found in the inspected attendance navigation; customer-role access to employee attendance endpoints was not runtime tested. Customer users are not granted owner overview/report routes by their role checks.

## 11. Feature status matrix

| Feature | Status | Evidence / qualification |
|---|---|---|
| Employee clock-in/out persistence | Partially working | Real database routes; date, role and concurrent request safeguards differ or are incomplete. |
| Employee Dashboard clock-in rule | Broken/inconsistent | Client-only 11:00 cutoff disagrees with backend and Time Tracking. |
| Time Tracking live elapsed timer | Working locally, stale server state | Ticks in browser, but server-side auto-clockout does not refresh the page. |
| 7 PM automatic clock-out | Implemented, runtime unverified | Primary-worker cron; deployment excerpt only proves schedule registration. Browser fallback is page/timezone dependent. |
| Clock-in status classification | Partially working | Hardcoded IST helper; UI fallback uses browser local time; messages use process local time. |
| Owner current-day roster | Working but stale/limited | Real endpoint and tenant filter; no polling, no on-leave distinction, “Present” means check-in exists. |
| Owner monthly detail/calendar | Working read-only | Real employee-specific API; no correction/edit actions surfaced in the page. |
| Owner direct attendance edit API | Implemented, UI not surfaced | Owner/admin endpoint, company-scoped, refuses processed records. |
| Employee correction request API | Implemented, UI not surfaced in attendance page | Separate correction table path; cutoff records cannot be requested after processor locks them. |
| HR correction workflow | Partially implemented / duplicated | Generic `hr_employee_requests` path can mark current row present/clear late rather than apply punch times; separate from `attendance_corrections`. |
| Shift assignment integration | Missing from attendance execution | Roster shift schema exists but attendance logic hardcodes 09:00–19:00. |
| Break tracking and net hours | Missing | No break data or subtraction in inspected code. |
| Payroll attendance linkage | Partially working | Totals are saved as reference; no attendance-based salary proration in current payroll route. |
| Biometric integration | Incomplete/security review needed | Webhook and device lookup exist; authentication/signature not visible. |
| Real-time Owner updates | Missing | Page fetches on mount only; no attendance SSE/polling in inspected route. |
| Production runtime verification | Unverified | No production DB/API/live employee records accessed. |

## 12. Tests and actual runtime verification

- `node --test tests/unit.test.js` — **84 passed, 0 failed** on 2026-10-17. This includes unit tests for the duplicated attendance status thresholds and working-hour arithmetic.
- No attendance-specific route integration test file was found under `tests/` in this snapshot; the test search returned `tests/unit.test.js` as the attendance-focused file.
- No API endpoint was called, no database query was run against production, and no actual employee record or notification was inspected.
- The tests do not cover the root causes found here: message timezone, Dashboard/Time Tracking disagreement, cron firing/SQL success, UTC/IST date-boundary behavior, role/tenant mutation path, stale UI after cron, or database uniqueness constraints.
- The user-provided Render excerpt shows the worker announcing the daily processor schedule. No matching execution log, affected-row count, or record timestamp was provided.

## 13. Prioritized recommendations

### Fix the reported bugs first

1. Establish one timezone policy (`Asia/Kolkata`) for all displayed attendance timestamps, server messages, date keys, and DB conversions; test UTC-host/browser combinations.
2. Move clock-in eligibility and classification into a single backend rule, and make Dashboard/Shift Control render the returned reason/status. Decide explicitly whether 11:00 is a hard cutoff or whether afternoon/overtime punches are allowed.
3. Keep the 19:00 cron as the authoritative server clock-out. Make it idempotent, emit success/failure metrics, verify one scheduler instance, provide missed-run recovery, and refresh clients after server-side changes. Remove or make the browser clock-out fallback one-shot and timezone-aware.
4. Use IST date selection consistently in clock-in, clock-out, `me`, overview, history, gatekeeper, manual process, and scheduled processing. Define overnight shift rules before applying date-key assumptions.
5. Reconcile status and hours calculations across manual clock-out, scheduled processing, and manual daily processing. Define breaks, rounding, half-day threshold, and overtime output explicitly.
6. Confirm an actual unique `(user_id,date)` constraint and handle duplicate historical sessions through a read-only reconciliation plan before enabling changes.

### Security and completeness

1. Restrict manual daily processing to a trusted system/super-admin operation or enforce tenant scope; do not let a company owner run a cross-company mutation.
2. Add explicit role checks to employee clock endpoints and authenticate biometric webhook requests with a signed secret/token plus replay protection.
3. Consolidate the generic HR attendance correction path and `attendance_corrections` into one audited workflow; expose approval/edit controls only if product policy intends them.
4. Connect assigned `hr_roster_shifts` to attendance policy only after agreed migration/backfill and overnight-shift behavior.
5. Add integration tests with an isolated database for duplicate clicks, concurrent punches, IST midnight, cron idempotence/restart, correction approval, company isolation, payroll snapshot behavior, and notification formatting.

---

**Final audit statement:** The source explains the reported UI mismatch and notification time discrepancy and shows a scheduled auto-clockout implementation. The report does not claim production diagnosis of a specific employee record or successful 19:00 run because those records and execution logs were not inspected.
