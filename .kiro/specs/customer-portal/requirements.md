# Requirements Document

## Introduction

The **Prozync Client Portal** is a standalone Next.js web application that gives end-customers of SmartERP companies a self-service interface to submit service jobs, track job progress in real time, and monitor the GPS location of the assigned field employee. It is completely separate from the existing SmartERP owner/employee frontend and communicates exclusively through a new `/api/customer/*` route namespace added to the existing Node.js + Express backend. No existing routes, middleware, or database tables are modified destructively; only additive changes (new table, safe `ALTER TABLE … ADD COLUMN IF NOT EXISTS`) are made.

---

## Glossary

- **Customer_Portal**: The new Next.js application branded as "Prozync Client Portal", served from a separate domain.
- **Customer**: An end-user who registers on the Customer_Portal with `role = 'customer'`. Stored in the new `customers` table.
- **Customer_Auth_Service**: The backend module that handles all `/api/customer/auth/*` routes.
- **Customer_Job_Service**: The backend module that handles all `/api/customer/jobs/*` routes.
- **Customer_Profile_Service**: The backend module that handles `/api/customer/profile` routes.
- **Tracking_Service**: The backend module that serves employee GPS coordinates to customers via `/api/customer/jobs/:id/tracking`.
- **SSE_Stream**: A Server-Sent Events endpoint at `/api/customer/jobs/:id/events` that pushes real-time job lifecycle events to the Customer_Portal.
- **OTP**: A 6-digit one-time password sent to the customer's email address for identity verification during manual signup.
- **Company_Code**: A short alphanumeric identifier that links a customer to a specific company in the SmartERP multi-tenant system.
- **JWT**: A JSON Web Token signed with the backend's `JWT_SECRET`, carrying `{ id, role: 'customer', companyId, email }`.
- **HttpOnly_Cookie**: A browser cookie with the `HttpOnly`, `SameSite=none`, and `Secure` flags set, used to transport JWTs.
- **Tenant_Guard**: The `authenticateCustomer` middleware that verifies the JWT, asserts `role === 'customer'`, and populates `req.customer`.
- **Leaflet_Map**: A Leaflet.js map component rendered client-side (SSR disabled) using OpenStreetMap tiles to display employee location.
- **Job_Timeline**: A chronological list of status-change events displayed on the job detail page.
- **Onboarding_Flow**: A multi-step page shown after Google OAuth signup where the customer provides `company_code` and `phone` before accessing the dashboard.
- **CSRF_Token**: A random token issued via `GET /api/customer/auth/csrf`, stored in a non-HttpOnly cookie (`csrf_token`) and echoed back in the `X-CSRF-Token` request header to prevent cross-site request forgery.
- **Login_Lockout**: A temporary 15-minute account lock applied after 5 consecutive failed login attempts for the same email or IP address.
- **Audit_Log**: A structured log entry written for every security-relevant event, containing customer/user id, IP address, timestamp, and action type.

---

## Requirements

### Requirement 1: Customer Database Schema

**User Story:** As a platform engineer, I want a dedicated `customers` table and safe additive columns on `jobs`, so that customer data is isolated from employee/owner data and jobs can be linked to the customer who created them.

#### Acceptance Criteria

1. THE Customer_Portal backend SHALL create a `customers` table with columns: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `name VARCHAR(255)`, `email VARCHAR(255) UNIQUE NOT NULL`, `phone VARCHAR(50)`, `password_hash VARCHAR(255)` (nullable), `company_id UUID REFERENCES companies(id)`, `auth_provider VARCHAR(20) DEFAULT 'manual'` (values: `'manual'` or `'google'`), `is_verified BOOLEAN DEFAULT FALSE`, `created_at TIMESTAMP DEFAULT NOW()`.
2. THE Customer_Portal backend SHALL add `customer_id UUID REFERENCES customers(id)` to the `jobs` table using `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id)`.
3. THE Customer_Portal backend SHALL add `source VARCHAR(50) DEFAULT 'owner'` to the `jobs` table using `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'owner'`.
4. THE Customer_Portal backend SHALL add `accepted_by UUID` to the `jobs` table using `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_by UUID`.
5. IF the `accepted_at` column already exists on the `jobs` table, THEN THE Customer_Portal backend SHALL skip adding it (using `ADD COLUMN IF NOT EXISTS`).
6. THE Customer_Portal backend SHALL create indexes: `idx_customers_email ON customers(email)`, `idx_customers_company_id ON customers(company_id)`, `idx_jobs_customer_id ON jobs(customer_id)`.

---

### Requirement 2: Customer Manual Signup with OTP Verification

**User Story:** As a prospective customer, I want to register with my name, email, password, phone, and company code after verifying my email with an OTP, so that I can securely access the portal for my company.

#### Acceptance Criteria

1. WHEN a POST request is made to `/api/customer/auth/send-otp` with a valid email, THE Customer_Auth_Service SHALL generate a 6-digit OTP, store it in the `email_otps` table with a 10-minute expiry, and send it to the provided email address via the Resend email service.
2. IF the same email address requests more than 5 OTPs within a 10-minute window, THEN THE Customer_Auth_Service SHALL return HTTP 429 with a message indicating the retry wait time.
3. THE Customer_Auth_Service SHALL enforce a minimum 60-second cooldown between OTP send requests for the same email address; IF a request arrives within 60 seconds of the previous OTP send, THEN THE Customer_Auth_Service SHALL return HTTP 429 with `{ message: "Please wait before requesting another OTP.", retryAfter: <seconds> }`.
4. WHEN a POST request is made to `/api/customer/auth/verify-otp` with a matching, unexpired, unused OTP, THE Customer_Auth_Service SHALL mark the OTP as used and return `{ ok: true, verified: true }`.
5. IF the OTP provided to `/api/customer/auth/verify-otp` is invalid, expired, or already used, THEN THE Customer_Auth_Service SHALL return HTTP 400 with `{ message: "Invalid or expired code." }` — the response SHALL NOT reveal whether the email address exists in the system.
6. WHEN a POST request is made to `/api/customer/auth/signup` with `name`, `email`, `password` (minimum 8 characters), `phone`, and `company_code`, and the email has a verified OTP within the last 15 minutes, THE Customer_Auth_Service SHALL hash the password with bcrypt (cost factor 10), insert a row into `customers` with `is_verified = TRUE`, `auth_provider = 'manual'`, and return HTTP 201 with `{ ok: true }`.
7. IF the `company_code` provided to `/api/customer/auth/signup` does not match any active company, THEN THE Customer_Auth_Service SHALL return HTTP 400 with `{ message: "Invalid company code" }`.
8. IF the email provided to `/api/customer/auth/signup` already exists in the `customers` table, THEN THE Customer_Auth_Service SHALL return HTTP 400 with `{ message: "Invalid credentials" }` — the response SHALL NOT reveal that the email is already registered.
9. IF the email provided to `/api/customer/auth/signup` has no verified OTP within the last 15 minutes, THEN THE Customer_Auth_Service SHALL return HTTP 403 with `{ message: "Email not verified. Please verify your email first." }`.

---

### Requirement 3: Customer Login and JWT Issuance

**User Story:** As a registered customer, I want to log in with my email and password so that I receive a secure JWT stored in an HttpOnly cookie.

#### Acceptance Criteria

1. WHEN a POST request is made to `/api/customer/auth/login` with valid `email` and `password` credentials matching a `customers` row with `is_verified = TRUE`, THE Customer_Auth_Service SHALL sign a JWT with payload `{ id, role: 'customer', companyId, email }` using `JWT_SECRET` with a 1-hour expiry, sign a refresh token with a 30-day expiry, store the refresh token in `refresh_tokens`, and set both as HttpOnly cookies (`SameSite=none`, `Secure`, `path=/`).
2. IF the email does not exist in the `customers` table, THEN THE Customer_Auth_Service SHALL return HTTP 401 with `{ message: "Invalid credentials" }` — the response SHALL NOT reveal whether the email address exists.
3. IF the password does not match the stored bcrypt hash, THEN THE Customer_Auth_Service SHALL return HTTP 401 with `{ message: "Invalid credentials" }` — the response SHALL NOT distinguish between a wrong password and an unknown email.
4. THE Customer_Auth_Service SHALL track failed login attempts per email address and per IP address using Redis. AFTER 5 consecutive failed attempts within a 15-minute window for the same email OR the same IP, THE Customer_Auth_Service SHALL return HTTP 429 with `{ message: "Too many failed attempts. Please try again in 15 minutes.", retryAfter: 900 }` and SHALL reject all further login attempts for that email/IP for 15 minutes regardless of credentials.
5. WHEN a Login_Lockout is active for an email address, THE Customer_Auth_Service SHALL return HTTP 429 with `{ message: "Too many failed attempts. Please try again in 15 minutes.", retryAfter: <seconds_remaining> }` without performing any password comparison, to prevent timing-based enumeration.
6. IF the customer's `is_verified` flag is `FALSE`, THEN THE Customer_Auth_Service SHALL return HTTP 403 with `{ message: "Please verify your email before logging in." }`.
7. IF the customer's associated company has `status = 'suspended'`, THEN THE Customer_Auth_Service SHALL return HTTP 403 with `{ message: "Account Suspended/Disabled" }`.
8. WHEN a POST request is made to `/api/customer/auth/refresh` with a valid, non-revoked refresh token cookie, THE Customer_Auth_Service SHALL rotate the refresh token (revoke old, issue new), update `refresh_tokens`, and return new access and refresh token cookies.
9. IF a refresh token that has already been revoked is presented to `/api/customer/auth/refresh`, THEN THE Customer_Auth_Service SHALL revoke all tokens in the same token family and return HTTP 401 with `{ message: "Security alert: Token reuse detected." }`.
10. WHEN a POST request is made to `/api/customer/auth/logout`, THE Customer_Auth_Service SHALL revoke the refresh token in the database and clear both access and refresh token cookies.

---

### Requirement 4: Customer Google OAuth Signup and Onboarding

**User Story:** As a prospective customer, I want to sign up using my Google account and then complete an onboarding step to provide my company code and phone number, so that I can access the portal without creating a password.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/customer/auth/google`, THE Customer_Auth_Service SHALL initiate a Google OAuth 2.0 authorization flow using a dedicated Passport.js strategy configured with a callback URL of `/api/customer/auth/google/callback`.
2. WHEN Google redirects to `/api/customer/auth/google/callback` with a valid authorization code for a new Google account (email does not exist in the `customers` table), THE Customer_Auth_Service SHALL create a `customers` row with `auth_provider = 'google'`, `is_verified = TRUE`, `password_hash = NULL`, and `company_id = NULL`, then redirect the browser to `{CUSTOMER_PORTAL_ORIGIN}/onboarding?token={tempToken}`.
3. WHEN Google redirects to `/api/customer/auth/google/callback` for an email that already exists in the `customers` table with `auth_provider = 'manual'`, THE Customer_Auth_Service SHALL NOT automatically link the Google identity to the existing account. Instead, THE Customer_Auth_Service SHALL redirect to `{CUSTOMER_PORTAL_ORIGIN}/login?error=account_exists&provider=google` so the customer can verify ownership first. **Automatic linking without verification is NOT allowed.**
4. WHEN a customer who has an existing `'manual'` account wishes to link their Google identity, they MUST first authenticate via their existing email and password (or OTP), and then explicitly request the link from their profile settings. Only after successful verification SHALL THE Customer_Auth_Service update `auth_provider = 'google'` and store the `google_id` on the existing `customers` row.
5. WHEN Google redirects to `/api/customer/auth/google/callback` for an existing customer account that already has `auth_provider = 'google'` and `company_id` set, THE Customer_Auth_Service SHALL issue a full JWT and redirect to `{CUSTOMER_PORTAL_ORIGIN}/dashboard`.
6. WHEN a POST request is made to `/api/customer/auth/onboarding` with a valid `tempToken`, `company_code`, and `phone`, THE Customer_Auth_Service SHALL validate the company code, update the `customers` row with `company_id` and `phone`, issue a full JWT cookie pair, and return `{ ok: true }`.
7. IF the `company_code` provided to `/api/customer/auth/onboarding` is invalid, THEN THE Customer_Auth_Service SHALL return HTTP 400 with `{ message: "Invalid company code" }`.
8. IF the `tempToken` provided to `/api/customer/auth/onboarding` is expired or invalid, THEN THE Customer_Auth_Service SHALL return HTTP 401 with `{ message: "Session expired. Please sign in again." }`.

---

### Requirement 5: Company Code Validation Endpoint

**User Story:** As a customer filling out the signup or onboarding form, I want to validate my company code in real time so that I get immediate feedback before submitting the form.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/customer/validate-company?code=XXX` with a valid company code, THE Customer_Auth_Service SHALL return HTTP 200 with `{ valid: true, companyName: "<name>" }`.
2. IF the company code provided to `/api/customer/validate-company` does not match any company, THEN THE Customer_Auth_Service SHALL return HTTP 200 with `{ valid: false }`.
3. THE Customer_Auth_Service SHALL respond to `/api/customer/validate-company` within 500ms under normal database load.

---

### Requirement 6: Customer Authentication Middleware

**User Story:** As a backend engineer, I want a dedicated `authenticateCustomer` middleware so that all protected customer routes verify the JWT and enforce the `role = 'customer'` constraint.

#### Acceptance Criteria

1. WHEN a request arrives at any protected `/api/customer/*` route, THE Tenant_Guard SHALL extract the JWT from the `customer_access_token` HttpOnly cookie or the `Authorization: Bearer` header.
2. WHEN the JWT is valid and `payload.role === 'customer'`, THE Tenant_Guard SHALL set `req.customer = payload` and call `next()`.
3. IF the JWT is missing, THE Tenant_Guard SHALL return HTTP 401 with `{ message: "Not authenticated" }`.
4. IF the JWT is invalid or expired, THE Tenant_Guard SHALL return HTTP 401 with `{ message: "Invalid or expired token" }`.
5. IF the JWT payload has `role !== 'customer'`, THE Tenant_Guard SHALL return HTTP 403 with `{ message: "Access denied" }`.
6. WHILE processing any protected customer route, THE Tenant_Guard SHALL make `req.customer.companyId` and `req.customer.id` available to downstream route handlers.

---

### Requirement 7: Customer Profile Management

**User Story:** As a logged-in customer, I want to view and update my profile information so that my contact details stay current.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/customer/profile` with a valid customer JWT, THE Customer_Profile_Service SHALL return the customer's `id`, `name`, `email`, `phone`, `company_id`, `auth_provider`, and `created_at` from the `customers` table, excluding `password_hash`.
2. WHEN a PUT request is made to `/api/customer/profile` with a valid customer JWT and a body containing `name` and/or `phone`, THE Customer_Profile_Service SHALL update the corresponding columns in the `customers` table and return the updated profile.
3. IF the PUT request body contains an `email` field, THEN THE Customer_Profile_Service SHALL ignore the email field (email changes are not permitted via this endpoint).
4. THE Customer_Profile_Service SHALL filter all profile queries by `id = req.customer.id` to prevent cross-customer data access.

---

### Requirement 8: Customer Job Creation

**User Story:** As a logged-in customer, I want to submit a new service job with a title, description, and priority so that the company's owner and employees are notified and can act on it.

#### Acceptance Criteria

1. WHEN a POST request is made to `/api/customer/jobs` with a valid customer JWT and a body containing `title` (required), `description` (optional), and `priority` (optional, one of `low`, `medium`, `high`, `urgent`), THE Customer_Job_Service SHALL insert a row into the `jobs` table with `customer_id = req.customer.id`, `company_id = req.customer.companyId`, `source = 'customer'`, `visible_to_all = TRUE`, `status = 'open'`, and `created_by = NULL`. The `created_by` column SHALL remain NULL for customer-created jobs to preserve the existing owner/employee flow where `created_by` always references a row in the `users` table.
2. WHEN a customer job is successfully created, THE Customer_Job_Service SHALL call `createNotificationForOwners` to notify all owners in the company with title "New Customer Job" and message containing the job title.
3. WHEN a customer job is successfully created, THE Customer_Job_Service SHALL call `createNotificationForCompany` to notify all employees in the company with title "New Job Available" and message containing the job title.
4. THE Customer_Job_Service SHALL return HTTP 201 with the created job object on success.
5. IF the `title` field is missing or empty, THEN THE Customer_Job_Service SHALL return HTTP 400 with `{ message: "Title is required" }`.
6. IF the `priority` value is not one of the allowed values, THEN THE Customer_Job_Service SHALL return HTTP 400 with `{ message: "Invalid priority value" }`.

---

### Requirement 9: Customer Job Listing and Detail

**User Story:** As a logged-in customer, I want to see a list of all jobs I have submitted and view the full details of any individual job, so that I can track the status of my requests.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/customer/jobs` with a valid customer JWT, THE Customer_Job_Service SHALL return only jobs where `customer_id = req.customer.id` AND `company_id = req.customer.companyId`, ordered by `created_at DESC`. Jobs that do not satisfy both conditions SHALL NOT be returned under any circumstances.
2. THE Customer_Job_Service SHALL include in each job response: `id`, `title`, `description`, `status`, `priority`, `employee_status`, `progress`, `assigned_to`, `created_at`, `accepted_at`, `completed_at`, and `source`.
3. WHEN a GET request is made to `/api/customer/jobs/:id` with a valid customer JWT, THE Customer_Job_Service SHALL return the full job detail only if `customer_id = req.customer.id` AND `company_id = req.customer.companyId`. Both conditions MUST be satisfied simultaneously.
4. IF the job with the given `:id` does not satisfy `customer_id = req.customer.id` AND `company_id = req.customer.companyId`, THEN THE Customer_Job_Service SHALL return HTTP 404 with `{ message: "Job not found" }` regardless of whether the job exists for a different customer or company.
5. THE Customer_Job_Service SHALL support pagination on the job list via `page` and `limit` query parameters, defaulting to `page=1` and `limit=20`.

---

### Requirement 10: Employee Location Tracking for Customer

**User Story:** As a customer with an active job, I want to see the real-time GPS location of the employee assigned to my job on a map, so that I know when they will arrive.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/customer/jobs/:id/tracking` with a valid customer JWT, THE Tracking_Service SHALL first verify ALL of the following conditions before proceeding: `job.customer_id = req.customer.id` AND `job.company_id = req.customer.companyId` AND `job.assigned_to IS NOT NULL`. IF any condition fails, THE Tracking_Service SHALL return HTTP 404 with `{ message: "Job not found" }` without revealing whether the job exists.
2. WHEN all three conditions in criterion 1 are satisfied and `employee_status = 'accepted'`, THE Tracking_Service SHALL query `employee_profiles` for the assigned employee's `latitude`, `longitude`, and `location_updated_at`, and return them along with the employee's `name`.
3. IF the job has no assigned employee (`assigned_to IS NULL`) after ownership is confirmed, THEN THE Tracking_Service SHALL return HTTP 200 with `{ available: false, reason: "No employee assigned yet" }`.
4. IF the job's `employee_status` is not `'accepted'` after ownership is confirmed, THEN THE Tracking_Service SHALL return HTTP 200 with `{ available: false, reason: "Employee has not accepted the job yet" }`.
5. IF the assigned employee has no location data in `employee_profiles`, THEN THE Tracking_Service SHALL return HTTP 200 with `{ available: true, latitude: null, longitude: null, location_updated_at: null }`.
6. THE Tracking_Service SHALL NOT expose the GPS coordinates of any employee to a customer unless that employee is the `assigned_to` value on a job that is owned by that customer (`customer_id = req.customer.id`) within the same company (`company_id = req.customer.companyId`).
7. THE Tracking_Service SHALL NOT accept an `employeeId` parameter directly from the client; the employee identity MUST be derived exclusively from `jobs.assigned_to` after the ownership check in criterion 1 passes.

---

### Requirement 11: Real-Time Job Updates via SSE

**User Story:** As a customer viewing a job detail page, I want to receive real-time updates when the job is accepted, progressed, or completed by an employee, so that I do not need to refresh the page.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/customer/jobs/:id/events` with a valid customer JWT (via cookie or `?token=` query parameter), THE SSE_Stream SHALL set response headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, and begin streaming.
2. WHEN the SSE connection is established, THE SSE_Stream SHALL send an initial `data: {"type":"connected","jobId":"<id>"}` event.
3. WHEN an employee accepts the customer's job (via the existing `/api/v1/jobs/:id/accept` route), THE Customer_Job_Service SHALL broadcast a `{ type: 'job_accepted', jobId, employeeName, acceptedAt }` event to the customer's SSE stream for that job.
4. WHEN an employee updates progress on the customer's job (via the existing `/api/v1/jobs/:id/progress` route), THE Customer_Job_Service SHALL broadcast a `{ type: 'job_progress', jobId, progress, status }` event to the customer's SSE stream for that job.
5. WHEN an employee completes the customer's job (progress = 100), THE Customer_Job_Service SHALL broadcast a `{ type: 'job_completed', jobId, completedAt }` event to the customer's SSE stream for that job.
6. THE SSE_Stream SHALL verify that the job belongs to the requesting customer before opening the stream.
7. IF the job does not belong to the requesting customer, THEN THE SSE_Stream SHALL return HTTP 403 with `{ message: "Access denied" }`.
8. WHEN the SSE client disconnects, THE SSE_Stream SHALL unregister the connection to prevent memory leaks.

---

### Requirement 12: CORS and Security Configuration

**User Story:** As a security engineer, I want the Customer_Portal domain to be explicitly whitelisted in the backend CORS and CSRF configuration, so that cross-origin requests with credentials work correctly and no unauthorized origins are permitted.

#### Acceptance Criteria

1. THE Customer_Portal backend SHALL add the Customer_Portal's production domain (e.g., `https://client.prozync.in`) and local development origin (`http://localhost:3001`) to the `allowedOrigins` array in `server.js`.
2. THE Customer_Portal backend SHALL add the Customer_Portal's production domain and local development origin to the CSRF `allowedPatterns` array in `server.js`.
3. WHEN a preflight OPTIONS request arrives from the Customer_Portal origin, THE Customer_Portal backend SHALL respond with HTTP 200 and the appropriate CORS headers including `Access-Control-Allow-Credentials: true`.
4. THE Customer_Portal backend SHALL apply a dedicated rate limiter to `/api/customer/auth/*` routes with a maximum of 20 requests per 15-minute window per IP.
5. THE Customer_Portal backend SHALL apply the general API rate limiter (300 requests per 15-minute window) to all other `/api/customer/*` routes.

---

### Requirement 13: Customer Portal Frontend — Authentication Pages

**User Story:** As a customer, I want polished login, signup, OTP verification, and onboarding pages so that I can register and access the portal with a smooth, modern experience.

#### Acceptance Criteria

1. THE Customer_Portal SHALL provide a `/login` page with email and password fields, a "Login with Google" button, floating input labels, and Framer Motion entrance animations.
2. THE Customer_Portal SHALL provide a `/signup` page with name, email, password, phone, and company code fields, a company code validation animation (loading spinner → green checkmark on success), and a "Sign up with Google" button.
3. WHEN the company code field on `/signup` loses focus and contains at least 4 characters, THE Customer_Portal SHALL call `GET /api/customer/validate-company?code=XXX` and display a loading spinner followed by a green checkmark (valid) or red X (invalid).
4. THE Customer_Portal SHALL provide a `/verify-otp` page with a 6-digit OTP input, a resend button (disabled for 60 seconds after send), and a countdown timer.
5. THE Customer_Portal SHALL provide an `/onboarding` page with a multi-step form collecting company code and phone number, with a step progress indicator and the same company code validation animation as `/signup`.
6. WHILE an authentication form is submitting, THE Customer_Portal SHALL disable the submit button and display a loading spinner to prevent duplicate submissions.
7. IF an authentication API call returns an error, THE Customer_Portal SHALL display the error message inline near the relevant field or at the top of the form.

---

### Requirement 14: Customer Portal Frontend — Dashboard

**User Story:** As a logged-in customer, I want a dashboard that shows a summary of my jobs and quick navigation to key actions, so that I can manage my service requests at a glance.

#### Acceptance Criteria

1. THE Customer_Portal SHALL provide a `/dashboard` page that displays the customer's name, a summary count of jobs by status (open, active, completed), and a list of the 5 most recent jobs.
2. WHEN the dashboard loads, THE Customer_Portal SHALL fetch job data from `GET /api/customer/jobs` and display color-coded status badges (open: blue, active: yellow, completed: green, cancelled: red).
3. THE Customer_Portal SHALL provide a prominent "Create New Job" button on the dashboard that navigates to `/create-job`.
4. THE Customer_Portal SHALL display a loading skeleton while job data is being fetched.
5. THE Customer_Portal SHALL be fully responsive and usable on mobile screens (minimum 320px width).

---

### Requirement 15: Customer Portal Frontend — Job Creation Page

**User Story:** As a logged-in customer, I want a form to submit a new service job with a title, description, and priority so that I can request service from the company.

#### Acceptance Criteria

1. THE Customer_Portal SHALL provide a `/create-job` page with fields for `title` (required), `description` (optional textarea), and `priority` (dropdown: low, medium, high, urgent).
2. WHEN the form is submitted with valid data, THE Customer_Portal SHALL POST to `/api/customer/jobs`, display a success toast notification, and redirect to `/dashboard`.
3. IF the API returns a validation error, THE Customer_Portal SHALL display the error message and keep the form data intact.
4. THE Customer_Portal SHALL validate that the `title` field is not empty before submitting and display an inline error if it is.

---

### Requirement 16: Customer Portal Frontend — Job Detail Page with Tracking Map

**User Story:** As a logged-in customer, I want to view the full details of a job including a status timeline and a live map showing the assigned employee's location, so that I can track progress and arrival.

#### Acceptance Criteria

1. THE Customer_Portal SHALL provide a `/job/[id]` page that fetches job details from `GET /api/customer/jobs/:id` and displays title, description, status badge, priority badge, progress bar (0–100%), and timestamps (created, accepted, completed).
2. THE Customer_Portal SHALL display a Job_Timeline section showing status-change events in chronological order with icons and relative timestamps.
3. WHEN the job has `employee_status = 'accepted'` and location data is available from `GET /api/customer/jobs/:id/tracking`, THE Customer_Portal SHALL render a Leaflet_Map with a marker at the employee's coordinates and a label showing the employee's name and last-updated time.
4. THE Customer_Portal SHALL import the Leaflet_Map component with `dynamic(() => import(...), { ssr: false })` to prevent server-side rendering errors.
5. WHEN the `/job/[id]` page is open, THE Customer_Portal SHALL establish an SSE connection to `/api/customer/jobs/:id/events` and update the job status, progress bar, and timeline in real time without a page refresh.
6. WHEN a `job_accepted` SSE event is received, THE Customer_Portal SHALL update the status badge, show the employee name, and begin polling `GET /api/customer/jobs/:id/tracking` every 15 seconds to refresh the map marker.
7. WHEN a `job_completed` SSE event is received, THE Customer_Portal SHALL stop the tracking poll, update the status badge to "Completed", and display a completion timestamp.
8. THE Customer_Portal SHALL close the SSE connection when the `/job/[id]` page is unmounted.

---

### Requirement 17: Customer Portal Frontend — Profile Page

**User Story:** As a logged-in customer, I want to view and edit my profile information so that my contact details are accurate.

#### Acceptance Criteria

1. THE Customer_Portal SHALL provide a `/profile` page that fetches data from `GET /api/customer/profile` and displays the customer's name, email (read-only), phone, and account creation date.
2. WHEN the customer edits their name or phone and submits the form, THE Customer_Portal SHALL PUT to `/api/customer/profile` and display a success toast on completion.
3. IF the PUT request fails, THE Customer_Portal SHALL display the error message and restore the previous field values.

---

### Requirement 18: Integration with Existing Employee and Owner Workflows

**User Story:** As an owner or employee using the existing SmartERP dashboard, I want customer-created jobs to appear in my job list automatically, so that I can accept and work on them without any workflow changes.

#### Acceptance Criteria

1. WHEN a customer creates a job via `POST /api/customer/jobs`, THE Customer_Job_Service SHALL set `visible_to_all = TRUE` so that the existing `GET /api/v1/jobs` owner query (which fetches all company jobs) returns the job without modification.
2. WHEN a customer creates a job via `POST /api/customer/jobs`, THE Customer_Job_Service SHALL set `visible_to_all = TRUE` so that the existing `GET /api/v1/jobs` employee query (which fetches jobs where `visible_to_all = TRUE OR assigned_to = user_id`) returns the job without modification.
3. WHEN an employee accepts a customer job via the existing `POST /api/v1/jobs/:id/accept` route, THE existing route handler SHALL update `assigned_to`, `employee_status`, and `accepted_at` as normal; the Customer_Job_Service SSE hook SHALL detect this change and broadcast a `job_accepted` event to the customer's SSE stream.
4. WHEN an employee updates progress on a customer job via the existing `POST /api/v1/jobs/:id/progress` route, THE Customer_Job_Service SSE hook SHALL broadcast a `job_progress` event to the customer's SSE stream.
5. THE Customer_Job_Service SHALL NOT modify any existing route handlers, middleware, or database queries in the `/api/v1/*` namespace.

---


### Requirement 19: Round-Trip Token Serialization

**User Story:** As a security engineer, I want to ensure that JWT tokens issued to customers can be correctly parsed and verified across the full request lifecycle, so that authentication is reliable.

#### Acceptance Criteria

1. FOR ALL valid customer JWT payloads `{ id, role: 'customer', companyId, email }`, signing then verifying the token with `JWT_SECRET` SHALL produce an equivalent payload (round-trip property).
2. THE Customer_Auth_Service SHALL use the same `JWT_SECRET` environment variable as the existing auth system for signing customer tokens.
3. WHEN a customer access token is set as an HttpOnly cookie and subsequently read by the `authenticateCustomer` middleware, THE Tenant_Guard SHALL successfully extract and verify the token without modification.

---

### Requirement 20: CSRF Protection

**User Story:** As a security engineer, I want all state-changing customer API requests to carry a verified CSRF token, so that cross-site request forgery attacks cannot be executed against authenticated customers.

#### Acceptance Criteria

1. THE Customer_Auth_Service SHALL expose a public endpoint `GET /api/customer/auth/csrf` that generates a cryptographically random token, sets it as a non-HttpOnly cookie named `csrf_token` (`SameSite=none`, `Secure`, `path=/`), and returns `{ csrfToken: "<token>" }` in the response body.
2. THE Customer_Portal frontend SHALL call `GET /api/customer/auth/csrf` on application load and store the returned token in memory, then include it as the `X-CSRF-Token` request header on every non-GET request to `/api/customer/*`.
3. WHEN a non-GET request arrives at any `/api/customer/*` route (excluding `/api/customer/auth/csrf` itself and SSE endpoints), THE Customer_Auth_Service SHALL validate that the `X-CSRF-Token` header value matches the `csrf_token` cookie value using a constant-time comparison.
4. IF the `X-CSRF-Token` header is missing or does not match the `csrf_token` cookie, THEN THE Customer_Auth_Service SHALL return HTTP 403 with `{ message: "Invalid CSRF token" }` and SHALL NOT process the request further.
5. IF the `csrf_token` cookie is absent, THEN THE Customer_Auth_Service SHALL return HTTP 403 with `{ message: "Invalid CSRF token" }`.
6. THE CSRF validation SHALL be skipped for requests that carry a valid `Authorization: Bearer` header, consistent with the existing backend CSRF bypass pattern for token-authenticated SPAs.
7. CSRF tokens SHALL be rotated on each successful login and logout to prevent token fixation.

---

### Requirement 21: Audit Logging

**User Story:** As a security engineer, I want every security-relevant action in the Customer Portal to produce a structured audit log entry, so that suspicious activity can be detected and investigated.

#### Acceptance Criteria

1. THE Customer_Auth_Service SHALL write an audit log entry for each of the following events: login success, login failure (including lockout triggers), OTP request, OTP verification failure, token refresh, token reuse detection (replay attack), logout, and unauthorized access attempt (401/403 responses on protected routes).
2. THE Tracking_Service SHALL write an audit log entry for every request to `/api/customer/jobs/:id/tracking`, recording whether access was granted or denied.
3. EACH audit log entry SHALL include: `customer_id` (or `null` if unauthenticated), `ip_address` (from `req.ip`), `timestamp` (ISO 8601 UTC), `action` (a string constant such as `'login_success'`, `'login_failure'`, `'otp_request'`, `'otp_failure'`, `'token_refresh'`, `'token_replay'`, `'logout'`, `'unauthorized_access'`, `'tracking_access'`, `'tracking_denied'`), and `metadata` (a JSON object with any additional context such as `jobId`, `reason`, or `attemptCount`).
4. Audit log entries SHALL be written to the existing `activities` table using the existing `activity_type` and `details` columns, with `company_id` set where available.
5. Audit log writes SHALL be non-blocking — a failure to write an audit log entry SHALL NOT cause the originating request to fail or return an error to the client.
6. THE Customer_Auth_Service SHALL log the `user_agent` string alongside each audit entry to assist in device fingerprinting during incident investigation.
