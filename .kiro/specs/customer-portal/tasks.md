# Implementation Plan: Prozync Client Portal

## Overview

Implement the Prozync Client Portal end-to-end: database migration, backend middleware and routes, Redis pub/sub SSE, additive changes to existing routes, and a brand-new Next.js 14 frontend. All backend changes are additive only. The frontend is a fresh app at `c:\Users\mrpre\Desktop\projectt`.

Property-based tests use **fast-check** (install as a dev dependency: `npm install --save-dev fast-check`). Each PBT task runs a minimum of 100 iterations and is tagged with `// Feature: customer-portal, Property N: <text>`.

---

## Tasks

- [x] 1. Database migration — create customers table and additive job columns
  - Create `backend/migrations/customer_portal_migration.sql` with all DDL from the design
  - `CREATE TABLE IF NOT EXISTS customers (id, name, email, phone, password_hash, company_id, auth_provider, google_id, is_verified, created_at)` — Requirements 1.1
  - `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id)` — Requirements 1.2
  - `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'owner'` — Requirements 1.3
  - `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_by UUID` — Requirements 1.4
  - `ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE CASCADE` — Requirements 3.8
  - All indexes: `idx_customers_email`, `idx_customers_company_id`, `idx_jobs_customer_id`, `idx_refresh_tokens_customer_id` — Requirements 1.6
  - Wire the migration into `server.js` `runDatabaseInitialization()` so it runs once on startup (additive only — safe to re-run)
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 2. customerAuthMiddleware — authenticateCustomer
  - Create `backend/middleware/customerAuthMiddleware.js`
  - Extract JWT from `customer_access_token` cookie first, then `Authorization: Bearer` header, then `?token=` query param (for SSE) — Requirements 6.1
  - Call `jwt.verify(token, process.env.JWT_SECRET)` — Requirements 19.2
  - If missing → 401 `{ message: "Not authenticated" }` — Requirements 6.3
  - If invalid/expired → 401 `{ message: "Invalid or expired token" }` — Requirements 6.4
  - If `payload.role !== 'customer'` → 403 `{ message: "Access denied" }` — Requirements 6.5
  - On success: `req.customer = payload`, call `next()` — Requirements 6.2, 6.6
  - Export `authenticateCustomer`
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ]* 2.1 Write property test for authenticateCustomer role enforcement
    - **Property 6: authenticateCustomer role enforcement**
    - **Validates: Requirements 6.2, 6.5**
    - Use `fast-check` to generate JWTs with arbitrary roles (`fc.constantFrom('owner','employee','admin','super_admin')` and `fc.string()`); assert middleware returns 403 for all non-`'customer'` roles
    - Generate JWTs with `role: 'customer'`; assert `req.customer` is set and `next()` is called
    - Tag: `// Feature: customer-portal, Property 6: authenticateCustomer role enforcement`
    - File: `backend/tests/customer-portal.pbt.test.js`

- [x] 3. Customer auth routes — OTP, signup, login, refresh, logout, CSRF
  - Create `backend/routes/customer/auth.js`
  - **CSRF endpoint** `GET /csrf`: generate `crypto.randomBytes(32).toString('hex')`, set non-HttpOnly `csrf_token` cookie (`SameSite=none`, `Secure`), return `{ csrfToken }` — Requirements 20.1
  - **CSRF validation middleware** (inline in auth router): for non-GET requests (excluding `/csrf` and SSE), compare `X-CSRF-Token` header to `csrf_token` cookie using `crypto.timingSafeEqual`; skip if `Authorization: Bearer` present; return 403 on mismatch — Requirements 20.3, 20.4, 20.5, 20.6
  - **`POST /send-otp`**: validate email, enforce 60s cooldown and 5-per-10min rate limit via Redis keys, generate 6-digit OTP, insert into `email_otps` with 10-min expiry, send via Resend — Requirements 2.1, 2.2, 2.3
  - **`POST /verify-otp`**: look up matching unexpired unused OTP, mark used, return `{ ok: true, verified: true }`; on failure return 400 with generic message — Requirements 2.4, 2.5
  - **`POST /signup`**: validate fields, check verified OTP within 15 min, validate company code, check email uniqueness (return generic 400 on duplicate), bcrypt hash password (cost 10), insert customer with `is_verified=TRUE auth_provider='manual'`, return 201 — Requirements 2.6, 2.7, 2.8, 2.9
  - **`POST /login`**: check Redis lockout first (return 429 without password compare if locked) — Requirements 3.5; look up customer, compare bcrypt hash; on failure increment Redis counter (email key + IP key), lock after 5 failures for 15 min — Requirements 3.4; on success sign 1h access JWT + 30d refresh JWT, store refresh token in `refresh_tokens` (`user_id=NULL, customer_id=<id>`), set HttpOnly cookies, rotate CSRF token — Requirements 3.1, 3.2, 3.3, 20.7; check `is_verified` → 403 — Requirements 3.6; check company `status='suspended'` → 403 — Requirements 3.7
  - **`POST /refresh`**: read `customer_refresh_token` cookie, look up in `refresh_tokens` where `customer_id IS NOT NULL`; if revoked → revoke entire family, return 401 — Requirements 3.9; else rotate (revoke old, insert new), return new cookies — Requirements 3.8
  - **`POST /logout`**: revoke refresh token, clear both cookies, rotate CSRF token — Requirements 3.10, 20.7
  - **`GET /google`**: initiate dedicated Passport `GoogleStrategy` with callback `/api/customer/auth/google/callback` — Requirements 4.1
  - **`GET /google/callback`**: new email → create customer row (`auth_provider='google'`, `is_verified=TRUE`, `company_id=NULL`), redirect to `{CUSTOMER_PORTAL_ORIGIN}/onboarding?token={tempToken}` — Requirements 4.2; existing manual account → redirect to login with `error=account_exists` — Requirements 4.3; existing google account with `company_id` set → issue full JWT, redirect to dashboard — Requirements 4.5
  - **`POST /onboarding`**: verify `tempToken`, validate company code, update customer row with `company_id` and `phone`, issue full JWT cookies, return `{ ok: true }` — Requirements 4.6, 4.7, 4.8
  - **`GET /validate-company`**: query companies by `company_id` code, return `{ valid: true, companyName }` or `{ valid: false }` — Requirements 5.1, 5.2
  - Write non-blocking audit log entries to `activities` table for all security events (login success/failure, OTP request/failure, token refresh, token replay, logout, unauthorized access) — Requirements 21.1, 21.3, 21.4, 21.5, 21.6
  - _Requirements: 2.1–2.9, 3.1–3.10, 4.1–4.8, 5.1–5.3, 20.1–20.7, 21.1, 21.3–21.6_

  - [ ]* 3.1 Write property test for JWT round-trip fidelity
    - **Property 1: JWT round-trip fidelity**
    - **Validates: Requirements 19.1**
    - Use `fc.record({ id: fc.uuid(), companyId: fc.uuid(), email: fc.emailAddress() })` to generate payloads; sign with `JWT_SECRET`, verify, assert all four fields (`id`, `role`, `companyId`, `email`) are identical to originals
    - Tag: `// Feature: customer-portal, Property 1: JWT round-trip fidelity`
    - File: `backend/tests/customer-portal.pbt.test.js`

  - [ ]* 3.2 Write property test for OTP verification round-trip
    - **Property 5: OTP verification round-trip**
    - **Validates: Requirements 2.4, 2.5**
    - Generate random 6-digit OTP strings; store in `email_otps` with future expiry; call verify-otp logic; assert first call returns `{ ok: true, verified: true }` and marks OTP used; assert second call with same OTP returns 400
    - Tag: `// Feature: customer-portal, Property 5: OTP verification round-trip`
    - File: `backend/tests/customer-portal.pbt.test.js`

  - [ ]* 3.3 Write property test for refresh token replay protection
    - **Property 7: Refresh token replay protection**
    - **Validates: Requirements 3.7**
    - Generate customer sessions; issue refresh token; rotate it (use it once); present the old token again; assert all tokens in the family are revoked and 401 is returned; assert no new access token is issued
    - Tag: `// Feature: customer-portal, Property 7: refresh token replay protection`
    - File: `backend/tests/customer-portal.pbt.test.js`

- [x] 4. Customer job routes — list, detail, create, tracking
  - Create `backend/routes/customer/jobs.js`
  - **`GET /`**: query `jobs WHERE customer_id = req.customer.id AND company_id = req.customer.companyId ORDER BY created_at DESC` with pagination (`page`, `limit`, default 1/20); return fields: `id, title, description, status, priority, employee_status, progress, assigned_to, created_at, accepted_at, completed_at, source` — Requirements 9.1, 9.2, 9.5
  - **`POST /`**: validate `title` (required) and `priority` (enum); insert job with `customer_id=req.customer.id`, `company_id=req.customer.companyId`, `source='customer'`, `visible_to_all=TRUE`, `status='open'`, `created_by=NULL`; call `createNotificationForOwners` and `createNotificationForCompany`; return 201 with created job — Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 18.1, 18.2
  - **`GET /:id`**: query with both `customer_id` and `company_id` predicates; return 404 if either fails — Requirements 9.3, 9.4
  - **`GET /:id/tracking`**: verify all three conditions (`customer_id`, `company_id`, `assigned_to IS NOT NULL`) before any data access; return 404 if any fails; query `employee_profiles` for location; handle no-employee, not-accepted, and no-location-data cases — Requirements 10.1–10.7
  - Write non-blocking audit log for every tracking request (granted or denied) — Requirements 21.2, 21.3
  - _Requirements: 8.1–8.6, 9.1–9.5, 10.1–10.7, 18.1, 18.2, 21.2, 21.3_

  - [ ]* 4.1 Write property test for customer job ownership isolation
    - **Property 2: Customer job ownership isolation**
    - **Validates: Requirements 9.1, 9.3, 9.4**
    - Seed jobs for multiple customers and companies; for any customer identity, call the list handler; assert every returned job satisfies `customer_id = req.customer.id AND company_id = req.customer.companyId`; assert no cross-customer or cross-company jobs appear
    - Tag: `// Feature: customer-portal, Property 2: customer job ownership isolation`
    - File: `backend/tests/customer-portal.pbt.test.js`

  - [ ]* 4.2 Write property test for customer job creation invariants
    - **Property 3: Customer job creation invariants**
    - **Validates: Requirements 8.1, 18.1, 18.2**
    - Use `fc.record({ title: fc.string({ minLength: 1 }), description: fc.option(fc.string()), priority: fc.option(fc.constantFrom('low','medium','high','urgent')) })` to generate job payloads; assert every persisted row has `created_by=NULL`, `customer_id=req.customer.id`, `company_id=req.customer.companyId`, `source='customer'`, `visible_to_all=TRUE`
    - Tag: `// Feature: customer-portal, Property 3: customer job creation invariants`
    - File: `backend/tests/customer-portal.pbt.test.js`

  - [ ]* 4.3 Write property test for employee location access control
    - **Property 4: Employee location access control**
    - **Validates: Requirements 10.1, 10.6, 10.7**
    - Generate combinations of `(requestingCustomerId, jobCustomerId, requestingCompanyId, jobCompanyId, assignedTo)` using `fc.uuid()`; assert location data is only returned when all three conditions pass simultaneously; assert 404 is returned if any single condition fails
    - Tag: `// Feature: customer-portal, Property 4: employee location access control`
    - File: `backend/tests/customer-portal.pbt.test.js`

- [x] 5. Customer profile route
  - Create `backend/routes/customer/profile.js`
  - **`GET /`**: query `customers WHERE id = req.customer.id`; return `id, name, email, phone, company_id, auth_provider, created_at` (exclude `password_hash`) — Requirements 7.1, 7.4
  - **`PUT /`**: strip `email` field from request body before building UPDATE; update only `name` and/or `phone`; return updated profile — Requirements 7.2, 7.3, 7.4
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 5.1 Write property test for profile email immutability
    - **Property 8: Profile email immutability**
    - **Validates: Requirements 7.3, 7.4**
    - Use `fc.record({ name: fc.option(fc.string()), phone: fc.option(fc.string()), email: fc.emailAddress() })` to generate PUT bodies that always include an email field; call the profile update handler; assert the stored email is unchanged after every update; assert the response reflects the original email
    - Tag: `// Feature: customer-portal, Property 8: profile email immutability`
    - File: `backend/tests/customer-portal.pbt.test.js`

- [x] 6. SSE route — real-time job events
  - Create `backend/routes/customer/sse.js`
  - **`GET /jobs/:id/events`**: accept JWT via cookie or `?token=` query param; call `authenticateCustomer`; verify `job.customer_id = req.customer.id AND job.company_id = req.customer.companyId`; return 403 if either fails — Requirements 11.6, 11.7
  - Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` — Requirements 11.1
  - Send initial `data: {"type":"connected","jobId":"<id>"}` event — Requirements 11.2
  - Subscribe to Redis channel `customer_job_events:{jobId}` using a dedicated `ioredis` subscriber client; forward published messages as SSE `data:` frames — Requirements 11.3, 11.4, 11.5
  - On `req.on('close')`: unsubscribe from Redis channel, clean up subscriber — Requirements 11.8
  - Fallback: if Redis is unavailable, send `connected` event then close after 30s — Design SSE Error Handling
  - _Requirements: 11.1–11.8_

  - [ ]* 6.1 Write property test for SSE ownership guard
    - **Property 9: SSE ownership guard**
    - **Validates: Requirements 11.6, 11.7**
    - Generate combinations of `(requestingCustomerId, jobCustomerId, requestingCompanyId, jobCompanyId)` using `fc.uuid()`; assert SSE stream opens (200) only when both `customerId` and `companyId` match; assert 403 is returned if either condition fails
    - Tag: `// Feature: customer-portal, Property 9: SSE ownership guard`
    - File: `backend/tests/customer-portal.pbt.test.js`

- [x] 7. Customer router index — mount all sub-routers
  - Create `backend/routes/customer/index.js`
  - Mount `auth.js` at `/auth`
  - Mount `jobs.js` at `/jobs` (protected by `authenticateCustomer`)
  - Mount `profile.js` at `/profile` (protected by `authenticateCustomer`)
  - Mount `sse.js` at `/jobs` (SSE handles its own auth via cookie/query token)
  - Export the combined router
  - _Requirements: 6.1, 12.4, 12.5_

- [x] 8. Checkpoint — backend routes complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Additive changes to existing routes/jobs.js — Redis publish hook
  - In `backend/routes/jobs.js`, after the successful `UPDATE` in `POST /:id/accept`: if `updatedJob.customer_id` is set and `redisClient.status === 'ready'`, publish `{ type: 'job_accepted', jobId, employeeName, acceptedAt }` to `customer_job_events:{jobId}` — Requirements 11.3, 18.3
  - In `backend/routes/jobs.js`, after the successful `UPDATE` in `POST /:id/progress`: if `updatedJob.customer_id` is set and `redisClient.status === 'ready'`, publish `{ type: 'job_progress', jobId, progress, status }` (and `{ type: 'job_completed', ... }` when `progress === 100`) to `customer_job_events:{jobId}` — Requirements 11.4, 11.5, 18.4
  - Both publish calls are non-destructive: wrapped in try/catch, failure does not affect the existing response — Requirements 18.5
  - _Requirements: 11.3, 11.4, 11.5, 18.3, 18.4, 18.5_

- [x] 10. server.js integration — CORS, CSRF patterns, rate limiters, route mounting
  - In `backend/server.js`, add `'http://localhost:3001'` and `'https://client.prozync.in'` to the `allowedOrigins` array — Requirements 12.1
  - Add `/^https:\/\/client\.prozync\.in$/` and `'http://localhost:3001'` to the `allowedPatterns` array in the CSRF middleware — Requirements 12.2
  - Add `'http://localhost:3001'` and `'https://client.prozync.in'` to the error handler's `allowedOrigins` array
  - Add a dedicated customer auth rate limiter (20 req / 15 min per IP) applied to `/api/customer/auth` — Requirements 12.4
  - Apply the existing `generalApiLimiter` (300 req / 15 min) to `/api/customer` non-auth routes — Requirements 12.5
  - Mount the customer router: `app.use('/api/customer', require('./routes/customer/index'))` — after the v1 router mount
  - Add `'X-CSRF-Token'` to the `allowedHeaders` array in `corsOptions`
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [x] 11. Checkpoint — full backend complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Frontend — scaffold Next.js 14 app
  - Initialize the app at `c:\Users\mrpre\Desktop\projectt`:
    ```
    npx create-next-app@latest . --typescript --tailwind --app --no-src-dir
    ```
  - Install runtime dependencies:
    ```
    npm install framer-motion axios react-leaflet leaflet js-cookie
    npm install --save-dev @types/leaflet fast-check
    ```
  - Create `lib/types.ts` — define `CustomerJWTPayload`, `Job`, `JobEvent`, `TrackingData`, `AuthState` TypeScript interfaces matching the design data models
  - Create `lib/api.ts` — axios instance with `baseURL: process.env.NEXT_PUBLIC_API_URL`, `withCredentials: true`; response interceptor: on 401 (non-refresh), attempt `POST /api/customer/auth/refresh` once then retry; request interceptor: attach `X-CSRF-Token` header from in-memory store on non-GET requests — Requirements 20.2
  - Create `context/AuthContext.tsx` — `AuthState` context with `customer`, `isLoading`, `login`, `logout`, `refresh`; call `GET /api/customer/auth/csrf` on mount and store token in memory — Requirements 20.2
  - Create `app/layout.tsx` — root layout wrapping children in `AuthProvider`
  - Create `.env.local` with `NEXT_PUBLIC_API_URL=http://localhost:4000`
  - _Requirements: 13.1–13.7, 20.2_

- [x] 13. Frontend — authentication pages
  - [x] 13.1 Create `components/auth/LoginForm.tsx`
    - Email + password fields with floating labels, Framer Motion entrance animation
    - "Login with Google" button linking to `GET /api/customer/auth/google`
    - Disable submit + show spinner while submitting — Requirements 13.6
    - Display inline error on API failure — Requirements 13.7
    - _Requirements: 13.1_

  - [x] 13.2 Create `components/auth/SignupForm.tsx` and `components/auth/CompanyCodeField.tsx`
    - `SignupForm`: name, email, password, phone fields + `CompanyCodeField` + "Sign up with Google" button
    - `CompanyCodeField`: on blur (≥4 chars) call `GET /api/customer/validate-company?code=XXX`; show spinner → green checkmark (valid) or red X (invalid) with animation — Requirements 13.3
    - _Requirements: 13.2, 13.3_

  - [x] 13.3 Create `components/auth/OtpInput.tsx`
    - 6-digit OTP input (individual boxes or single field)
    - Resend button disabled for 60s with countdown timer — Requirements 13.4
    - _Requirements: 13.4_

  - [x] 13.4 Create auth pages: `app/(auth)/login/page.tsx`, `app/(auth)/signup/page.tsx`, `app/(auth)/verify-otp/page.tsx`, `app/(auth)/onboarding/page.tsx`
    - `/login` — renders `LoginForm`
    - `/signup` — renders `SignupForm`, on submit calls `POST /api/customer/auth/send-otp` then navigates to `/verify-otp`
    - `/verify-otp` — renders `OtpInput`, on verify calls `POST /api/customer/auth/verify-otp` then navigates to `/signup` completion or `/dashboard`
    - `/onboarding` — multi-step form (company code + phone) with step progress indicator; reads `?token=` from URL; on submit calls `POST /api/customer/auth/onboarding` then navigates to `/dashboard` — Requirements 13.5
    - _Requirements: 13.1–13.7_

- [x] 14. Frontend — shared UI components
  - Create `components/ui/LoadingSkeleton.tsx` — animated skeleton placeholder — Requirements 14.4
  - Create `components/ui/Toast.tsx` — toast notification component (success/error/info variants)
  - Create `components/layout/Navbar.tsx` — top navigation with customer name, logout button
  - Create `components/jobs/JobStatusBadge.tsx` — color-coded badge: open=blue, active=yellow, completed=green, cancelled=red — Requirements 14.2
  - _Requirements: 14.2, 14.4_

- [x] 15. Frontend — dashboard page
  - Create `app/(portal)/dashboard/page.tsx`
  - Fetch `GET /api/customer/jobs` on mount; display customer name, status summary counts, 5 most recent jobs as `JobCard` components — Requirements 14.1
  - Show `LoadingSkeleton` while fetching — Requirements 14.4
  - "Create New Job" button navigating to `/create-job` — Requirements 14.3
  - Fully responsive (min 320px) — Requirements 14.5
  - Create `components/jobs/JobCard.tsx` — displays title, status badge, priority, created date
  - _Requirements: 14.1–14.5_

- [x] 16. Frontend — job creation page
  - Create `app/(portal)/create-job/page.tsx`
  - Form with `title` (required), `description` (textarea), `priority` (dropdown: low/medium/high/urgent)
  - Inline validation: show error if title is empty before submit — Requirements 15.4
  - On submit: `POST /api/customer/jobs`; on success show toast and redirect to `/dashboard` — Requirements 15.2
  - On API error: display error message, keep form data intact — Requirements 15.3
  - _Requirements: 15.1–15.4_

- [x] 17. Frontend — job detail page with SSE and tracking map
  - Create `hooks/useSSE.ts` — manages `EventSource` connection to `/api/customer/jobs/:id/events?token=<jwt>`; handles reconnect with exponential backoff (1s, 2s, 4s, max 30s); closes on unmount — Requirements 16.5, 16.8
  - Create `hooks/useJobTracking.ts` — polls `GET /api/customer/jobs/:id/tracking` every 15s when `employee_status === 'accepted'`; stops polling on job completion — Requirements 16.6, 16.7
  - Create `components/jobs/JobTimeline.tsx` — chronological list of status-change events with icons and relative timestamps — Requirements 16.2
  - Create `components/jobs/TrackingMap.tsx` — Leaflet map with employee marker and name/last-updated label; import with `dynamic(() => import(...), { ssr: false })` — Requirements 16.3, 16.4
  - Create `app/(portal)/job/[id]/page.tsx`
    - Fetch `GET /api/customer/jobs/:id` on mount; display title, description, status badge, priority badge, progress bar (0–100%), timestamps — Requirements 16.1
    - Render `JobTimeline` — Requirements 16.2
    - Render `TrackingMap` when `employee_status === 'accepted'` and location available — Requirements 16.3
    - Connect `useSSE` hook; on `job_accepted` event: update status badge, show employee name, start tracking poll — Requirements 16.6
    - On `job_progress` event: update progress bar and status — Requirements 16.5
    - On `job_completed` event: stop tracking poll, update status badge to "Completed", display completion timestamp — Requirements 16.7
    - Close SSE on page unmount — Requirements 16.8
  - _Requirements: 16.1–16.8_

- [x] 18. Frontend — profile page
  - Create `app/(portal)/profile/page.tsx`
  - Fetch `GET /api/customer/profile` on mount; display name, email (read-only), phone, account creation date — Requirements 17.1
  - Editable name and phone fields; on submit `PUT /api/customer/profile`; show success toast — Requirements 17.2
  - On PUT failure: display error message and restore previous field values — Requirements 17.3
  - _Requirements: 17.1–17.3_

- [x] 19. Final checkpoint — full stack complete
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP delivery
- All PBT tasks use `fast-check` with a minimum of 100 iterations (`fc.assert(fc.property(...), { numRuns: 100 })`)
- PBT test file: `backend/tests/customer-portal.pbt.test.js` — run with `node --test tests/customer-portal.pbt.test.js`
- Backend changes to `server.js` and `routes/jobs.js` are strictly additive — no existing logic is removed or modified
- The `customer_access_token` cookie uses `SameSite=none; Secure; HttpOnly; path=/` — requires HTTPS in production
- The `refresh_tokens` table stores customer tokens with `user_id=NULL` and `customer_id=<uuid>` to avoid the existing FK constraint on `user_id`
- Frontend runs on port 3001 (`NEXT_PUBLIC_API_URL=http://localhost:4000` in `.env.local`)
- The Leaflet map must be imported with `dynamic(..., { ssr: false })` to avoid Next.js SSR errors
- Google OAuth for customers uses a separate Passport strategy with callback `/api/customer/auth/google/callback` — never interferes with the existing employee/owner OAuth flow
