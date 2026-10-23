# SmartERP Attendance Implementation Report

**Status:** Local implementation complete; integration and production behavior are not verified.
**Date:** 2026-10-17

## Canonical attendance workflow

`services/attendancePolicyService.js` is now the shared policy and calculation layer for attendance routes, employee clock actions, corrections, and daily processing. It reads the company policy from the existing `company_settings` store and applies the approved Asia/Kolkata policy consistently. Attendance routes keep existing endpoint shapes while using company-scoped identity and canonical calculations.

The approved defaults are recorded in `SMARTERP_ATTENDANCE_IMPLEMENTATION_PLAN.md`: 09:00–19:00 shift, 09:00 earliest clock-in, no grace period, late after 09:00, half-day threshold at 13:00, clock-in cutoff after 11:00, early departure before 19:00 as half-day, automatic clock-out at 19:00, elapsed hours without break deduction rounded to two decimals, and `Asia/Kolkata` timezone. Policy changes are blocked after attendance activity for the current date so they take effect on a subsequent work date.

## Changes made

### Shared backend

- `services/attendancePolicyService.js` centralizes policy validation/storage, zoned date and time calculation, eligibility, attendance status and hours, advisory locking, approved-leave lookup, and tenant-scoped daily processing.
- `routes/attendance.js` uses the shared service for employee punches, current attendance, history, owner overview, corrections, daily processing, and biometric punches. Punch requests are serialized by employee and work date; retrying an already successful punch is idempotent. Owner policy controls are company scoped and owner restricted.
  - `services/biometricWebhookAuth.js` validates an HMAC, timestamp freshness, and one-time nonce through Redis. The signed bytes are `${timestamp}.${nonce}.${JSON.stringify(body)}`. The route remains disabled unless both `BIOMETRIC_WEBHOOK_ENABLED=true` and `BIOMETRIC_GATEWAY_CONTRACT_VERIFIED=true`; do not enable it until the gateway contract is confirmed and tested.
- `jobs/dailyAttendanceProcessor.js` runs processing per company, acquires a run lock, and checks current and prior-day dates on startup/recovery.
- `middleware/attendanceGatekeeperMiddleware.js`, `services/attendanceService.js`, and `routes/hr.js` now use company-scoped attendance/date handling and canonical calculations for attendance-related checks and corrections.
- No database migration or historical attendance rewrite was made.

### Portals

- Owner Attendance page: policy controls, late/leave summaries, and periodic/focus refresh use the existing screen.
- Owner attendance detail and HR attendance screens: display IST values and status/leave summaries from existing APIs.
- Employee Dashboard, Time Tracking → Shift Control, and `/employee/time`: refresh the authoritative server attendance state periodically and on focus. Clock availability is provided by the backend policy.
- `components/clock-in-out.tsx` and `components/smart-clock-in-out.tsx`: use server policy/state; browser-side automatic clock-out writes were removed. Offline punches remain visibly pending and are not replayed with client timestamps.

## Tests and checks actually run

- Backend `npm test`: **84 passed**.
- Backend focused tests `node --test tests/attendancePolicyService.test.js tests/biometricWebhookAuth.test.js`: **13 passed**.
- `node --check` on changed backend JavaScript files: passed.
- Frontend `npx tsc --noEmit --pretty false`: passed with zero TypeScript errors.
- `git diff --check` in both repositories: passed; Git emitted only line-ending conversion warnings.

Production APIs were not called. No database migrations, commits, pushes, or deployments were performed.

## Outstanding verification and limitations

1. **Database and tenant integration:** No isolated test database was available or confirmed. The existing `tests/rls.test.js` invokes migrations and depends on `DATABASE_URL`, so it was not run. The tracked schema does not establish that every runtime attendance table/index matches deployment. Verify the deployed `company_settings`, attendance columns, RLS policies, and constraints against a disposable isolated database before rollout.
2. **Duplicate protection:** Transaction advisory locks serialize updated application writers. No unique database constraint was added or verified; legacy duplicate attendance rows are skipped rather than rewritten. Verify the deployed unique keys and reconcile duplicates with a reviewed, non-destructive plan before relying on DB-level uniqueness.
  3. **Biometric integration:** The disabled endpoint requires both `BIOMETRIC_WEBHOOK_ENABLED=true` and `BIOMETRIC_GATEWAY_CONTRACT_VERIFIED=true`, plus `BIOMETRIC_WEBHOOK_SECRET`, Redis nonce storage, and headers `x-device-signature`, `x-device-timestamp`, and `x-device-nonce`. Its HMAC is SHA-256 over the UTF-8 bytes `${timestamp}.${nonce}.${JSON.stringify(req.body)}`. The gateway contract remains unverified; keep the integration disabled until the vendor confirms this exact format and a route integration test passes. The current secret is shared at environment level, not provisioned per device.
4. **Recovery window:** Automatic recovery processes today and yesterday. Historical processing is skipped when the company policy was changed after that work date; older missed days require review. A long outage spanning more than one missed day is therefore not automatically reconstructed.
5. **Policy semantics:** The strict 11:00 cutoff makes the 13:00 half-day threshold unreachable for a new clock-in; 13:00 remains relevant for legacy/corrected attendance, while an early clock-out can produce a half-day. Confirm this is the intended business rule before broad rollout.
6. **Offline and notifications:** Offline punches are not accepted/replayed; employees must submit while online. Existing manual clock-out notifications remain, but no new notification was added for scheduler-generated auto clock-outs.
7. **Owner controls:** A policy update is rejected after attendance has been recorded for the current company work date. Verify the UI error handling and operational process for scheduling a policy change to the next date.

## Rollback considerations

No schema or historical data rollback is required. To roll back application behavior, revert the attendance-specific route/service/scheduler/middleware and portal changes together. Before rollback, account for the new policy keys stored in `company_settings`; they are additive and should be left intact unless a separately reviewed cleanup is approved. Do not remove historical attendance rows or change existing totals during rollback.

## Next verification gate

Before production rollout, create a disposable database matching the deployed schema and RLS setup, then run route-level tenant and role tests, concurrent duplicate punch tests, timezone and daylight/date-boundary cases, scheduler crash/restart recovery, leave exclusion, and the biometric replay/signature suite. Confirm biometric protocol compatibility and database uniqueness with the Owner/operations team. No production verification is claimed by this report.
