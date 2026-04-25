# Design Document: Prozync Client Portal

## Overview

The Prozync Client Portal is a standalone Next.js 14 web application that gives end-customers of SmartERP companies a self-service interface to submit service jobs, track job progress in real time, and monitor the GPS location of the assigned field employee. It is completely separate from the existing SmartERP owner/employee frontend and communicates exclusively through a new `/api/customer/*` route namespace added to the existing Node.js + Express backend.

The portal is branded as **"Prozync Client Portal"** and served from `http://localhost:3001` (dev) / `https://client.prozync.in` (prod). No existing routes, middleware, or database tables are modified destructively — only additive changes are made.

### Key Design Principles

- **Strict tenant isolation**: Every customer query is double-filtered by `customer_id = req.customer.id AND company_id = req.customer.companyId`.
- **No cross-table identity bleed**: Customers live in the `customers` table, never in `users`. `created_by` on jobs is always `NULL` for customer-created jobs.
- **Additive-only backend changes**: All schema changes use `ADD COLUMN IF NOT EXISTS`. No existing routes are touched.
- **Redis pub/sub for SSE**: Because the backend runs in cluster mode (multiple workers), SSE connections are coordinated via Redis pub/sub channels rather than an in-process Map.
- **Separate Passport strategy**: Google OAuth for customers uses a dedicated `GoogleStrategy` with a different callback URL (`/api/customer/auth/google/callback`) so it never interferes with the existing employee/owner OAuth flow.

---

## Architecture

### System Context

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Internet / Browser                           │
└──────────────┬──────────────────────────────────┬───────────────────┘
               │                                  │
               ▼                                  ▼
┌──────────────────────────┐        ┌─────────────────────────────────┐
│  SmartERP Frontend       │        │  Prozync Client Portal          │
│  (Vercel / prozync.in)   │        │  (Next.js 14, localhost:3001 /  │
│  Owner + Employee UI     │        │   client.prozync.in)            │
└──────────┬───────────────┘        └──────────────┬──────────────────┘
           │ /api/v1/*                              │ /api/customer/*
           ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  Node.js + Express Backend                           │
│  (Render / smarterp-backendend.onrender.com)                        │
│                                                                      │
│  ┌─────────────────────┐   ┌──────────────────────────────────────┐ │
│  │  /api/v1/* routes   │   │  /api/customer/* routes (NEW)        │ │
│  │  (existing, untouched)  │  ├─ /auth/*  (CustomerAuthService)   │ │
│  │                     │   │  ├─ /jobs/*  (CustomerJobService)    │ │
│  │  authenticateToken  │   │  ├─ /profile (CustomerProfileService)│ │
│  │  req.user           │   │  └─ /jobs/:id/events (SSE_Stream)    │ │
│  └─────────────────────┘   │                                      │ │
│                             │  authenticateCustomer middleware     │ │
│                             │  req.customer                        │ │
│                             └──────────────────────────────────────┘ │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Shared Infrastructure                                        │   │
│  │  PostgreSQL (Neon) │ Redis (ioredis) │ Resend email          │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Request Flow — Customer Auth

```
Browser → POST /api/customer/auth/login
        → authenticateCustomer (skipped — public route)
        → customerAuthRouter
        → bcrypt.compare
        → jwt.sign({ id, role:'customer', companyId, email })
        → Set-Cookie: customer_access_token (HttpOnly, SameSite=none, Secure)
        → Set-Cookie: customer_refresh_token (HttpOnly, SameSite=none, Secure)
        → 200 { ok: true }
```

### Request Flow — Protected Customer Route

```
Browser → GET /api/customer/jobs (with customer_access_token cookie)
        → authenticateCustomer middleware
            → extract token from cookie or Authorization header
            → jwt.verify(token, JWT_SECRET)
            → assert payload.role === 'customer'
            → req.customer = payload
        → customerJobRouter
        → SELECT ... WHERE customer_id = req.customer.id AND company_id = req.customer.companyId
        → 200 [jobs]
```

### SSE + Redis Pub/Sub Flow (Cluster-Safe)

```
Customer Browser ──── GET /api/customer/jobs/:id/events ────► Worker A
                                                               │
                                                               │ subscribe to
                                                               │ Redis channel:
                                                               │ customer_job_events:{jobId}
                                                               │
Employee Browser ──── POST /api/v1/jobs/:id/accept ─────────► Worker B
                                                               │
                                                               │ PUBLISH to Redis:
                                                               │ customer_job_events:{jobId}
                                                               │ { type:'job_accepted', ... }
                                                               │
                                                               ▼
                                                         Redis pub/sub
                                                               │
                                                               ▼
                                                         Worker A receives
                                                         → writes SSE event
                                                         → Customer Browser
```

---

## Components and Interfaces

### Backend New Files

```
backend/
├── middleware/
│   └── customerAuthMiddleware.js     ← authenticateCustomer
├── routes/
│   ├── customer/
│   │   ├── index.js                  ← mounts all customer sub-routers
│   │   ├── auth.js                   ← /api/customer/auth/*
│   │   ├── jobs.js                   ← /api/customer/jobs/*
│   │   ├── profile.js                ← /api/customer/profile
│   │   └── sse.js                    ← /api/customer/jobs/:id/events
```

### Frontend New Files (Next.js 14 App Router)

```
frontend/  (c:\Users\mrpre\Desktop\projectt)
├── app/
│   ├── layout.tsx                    ← root layout, AuthProvider
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   ├── verify-otp/page.tsx
│   │   └── onboarding/page.tsx
│   ├── (portal)/
│   │   ├── dashboard/page.tsx
│   │   ├── create-job/page.tsx
│   │   ├── job/[id]/page.tsx
│   │   └── profile/page.tsx
├── components/
│   ├── auth/
│   │   ├── LoginForm.tsx
│   │   ├── SignupForm.tsx
│   │   ├── OtpInput.tsx
│   │   └── CompanyCodeField.tsx      ← with validation animation
│   ├── jobs/
│   │   ├── JobCard.tsx
│   │   ├── JobTimeline.tsx
│   │   ├── JobStatusBadge.tsx
│   │   └── TrackingMap.tsx           ← dynamic import, ssr:false
│   ├── layout/
│   │   ├── Navbar.tsx
│   │   └── Sidebar.tsx
│   └── ui/
│       ├── LoadingSkeleton.tsx
│       └── Toast.tsx
├── context/
│   └── AuthContext.tsx               ← React Context for auth state
├── lib/
│   ├── api.ts                        ← axios instance with interceptors
│   └── types.ts                      ← shared TypeScript types
└── hooks/
    ├── useSSE.ts                     ← SSE connection hook
    └── useJobTracking.ts             ← polling hook for location
```

### authenticateCustomer Middleware Interface

```typescript
// middleware/customerAuthMiddleware.js
function authenticateCustomer(req, res, next): void
// Sets req.customer = { id, role, companyId, email } on success
// Returns 401 if token missing or invalid
// Returns 403 if role !== 'customer'
```

### Customer Auth Routes Interface

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/customer/auth/send-otp` | Public | Send OTP to email |
| POST | `/api/customer/auth/verify-otp` | Public | Verify OTP |
| POST | `/api/customer/auth/signup` | Public | Register with OTP |
| POST | `/api/customer/auth/login` | Public | Login, get JWT cookies |
| POST | `/api/customer/auth/refresh` | Public (cookie) | Rotate refresh token |
| POST | `/api/customer/auth/logout` | Public (cookie) | Revoke token, clear cookies |
| GET | `/api/customer/auth/google` | Public | Initiate Google OAuth |
| GET | `/api/customer/auth/google/callback` | Public | Google OAuth callback |
| POST | `/api/customer/auth/onboarding` | Public (tempToken) | Complete Google onboarding |
| GET | `/api/customer/validate-company` | Public | Validate company code |

### Customer Job Routes Interface

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/customer/jobs` | Customer JWT | List own jobs (paginated) |
| POST | `/api/customer/jobs` | Customer JWT | Create new job |
| GET | `/api/customer/jobs/:id` | Customer JWT | Get job detail |
| GET | `/api/customer/jobs/:id/tracking` | Customer JWT | Get employee location |
| GET | `/api/customer/jobs/:id/events` | Customer JWT (cookie or ?token=) | SSE stream |

### Customer Profile Routes Interface

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/customer/profile` | Customer JWT | Get profile |
| PUT | `/api/customer/profile` | Customer JWT | Update name/phone |

---

## Data Models

### New Table: `customers`

```sql
CREATE TABLE IF NOT EXISTS customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255),
  email           VARCHAR(255) UNIQUE NOT NULL,
  phone           VARCHAR(50),
  password_hash   VARCHAR(255),                          -- NULL for Google-only accounts
  company_id      UUID REFERENCES companies(id),
  auth_provider   VARCHAR(20) DEFAULT 'manual',          -- 'manual' | 'google'
  google_id       VARCHAR(255),
  is_verified     BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_email      ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_company_id ON customers(company_id);
```

### Additive Changes to `jobs` Table

```sql
-- All use IF NOT EXISTS — safe to run on existing production DB
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_id  UUID REFERENCES customers(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source       VARCHAR(50) DEFAULT 'owner';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS accepted_by  UUID;
-- accepted_at already exists in schema.sql — skipped via IF NOT EXISTS

CREATE INDEX IF NOT EXISTS idx_jobs_customer_id ON jobs(customer_id);
```

### JWT Payload Shape

```typescript
// Customer access token payload
interface CustomerJWTPayload {
  id:        string;   // customers.id (UUID)
  role:      'customer';
  companyId: string;   // companies.id (UUID)
  email:     string;
  iat:       number;
  exp:       number;
}
```

### Cookie Names

| Cookie | Value | Flags |
|--------|-------|-------|
| `customer_access_token` | 1h JWT | HttpOnly, SameSite=none, Secure, path=/ |
| `customer_refresh_token` | 30d JWT | HttpOnly, SameSite=none, Secure, path=/ |

### Refresh Token Storage

Customer refresh tokens are stored in the **existing** `refresh_tokens` table. The `user_id` column references `users(id)` with a FK constraint, so customer refresh tokens cannot use that column directly. Instead, the customer refresh token stores the customer UUID in a separate approach: the `user_id` FK is relaxed to allow NULL, and a new `customer_id` column is added.

```sql
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;
```

When issuing a customer refresh token, `user_id = NULL` and `customer_id = <customer UUID>`. The refresh endpoint checks `customer_id` when `user_id IS NULL`.

### SSE Event Shapes

```typescript
// Sent on connection open
{ type: 'connected', jobId: string }

// Sent when employee accepts job
{ type: 'job_accepted', jobId: string, employeeName: string, acceptedAt: string }

// Sent when employee updates progress
{ type: 'job_progress', jobId: string, progress: number, status: string }

// Sent when job is completed (progress = 100)
{ type: 'job_completed', jobId: string, completedAt: string }
```

### Redis Pub/Sub Channel Naming

```
customer_job_events:{jobId}
```

Each SSE connection subscribes to the channel for its specific job. When the existing `/api/v1/jobs/:id/accept` or `/api/v1/jobs/:id/progress` routes update a job that has `customer_id IS NOT NULL`, they publish to the corresponding Redis channel.

**Publishing hook** — added to `routes/jobs.js` accept and progress handlers (non-destructive addition):

```javascript
// After successful job update, if job has a customer_id:
if (updatedJob.customer_id && redisClient && redisClient.status === 'ready') {
  const channel = `customer_job_events:${updatedJob.id}`;
  redisClient.publish(channel, JSON.stringify(eventPayload));
}
```

### Frontend Auth Context Shape

```typescript
interface AuthState {
  customer: CustomerJWTPayload | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}
```

### Axios API Client Configuration

```typescript
// lib/api.ts
const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,  // http://localhost:4000 (dev)
  withCredentials: true,                      // send HttpOnly cookies
});

// Response interceptor: on 401, attempt token refresh then retry
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (error.response?.status === 401 && !error.config._retry) {
      error.config._retry = true;
      await api.post('/api/customer/auth/refresh');
      return api(error.config);
    }
    return Promise.reject(error);
  }
);
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: JWT Round-Trip Fidelity

*For any* valid customer JWT payload `{ id, role: 'customer', companyId, email }`, signing the payload with `JWT_SECRET` and then verifying the resulting token SHALL produce a decoded payload where `id`, `role`, `companyId`, and `email` are identical to the original values.

**Validates: Requirements 19.1**

### Property 2: Customer Job Ownership Isolation

*For any* customer making a GET request to `/api/customer/jobs`, every job in the response SHALL satisfy `customer_id = req.customer.id` AND `company_id = req.customer.companyId`. No job belonging to a different customer or a different company SHALL ever appear in the response, regardless of how many jobs exist in the database.

**Validates: Requirements 9.1, 9.3, 9.4**

### Property 3: Customer Job Creation Invariants

*For any* valid job creation request from a customer, the persisted job row SHALL have `created_by = NULL`, `customer_id = req.customer.id`, `company_id = req.customer.companyId`, `source = 'customer'`, and `visible_to_all = TRUE`. These five invariants SHALL hold regardless of the job title, description, or priority provided.

**Validates: Requirements 8.1, 18.1, 18.2**

### Property 4: Employee Location Access Control

*For any* tracking request to `/api/customer/jobs/:id/tracking`, employee GPS coordinates SHALL only be returned when ALL THREE of the following conditions are simultaneously true: `job.customer_id = req.customer.id` AND `job.company_id = req.customer.companyId` AND `job.assigned_to IS NOT NULL`. If any single condition fails, the endpoint SHALL return 404 without revealing whether the job exists.

**Validates: Requirements 10.1, 10.6, 10.7**

### Property 5: OTP Verification Round-Trip

*For any* 6-digit OTP stored in `email_otps` for a given email address that has not expired and has not been used, calling verify-otp with that exact OTP SHALL return `{ ok: true, verified: true }` and mark the OTP as used, such that a second call with the same OTP SHALL return HTTP 400.

**Validates: Requirements 2.4, 2.5**

### Property 6: authenticateCustomer Role Enforcement

*For any* JWT signed with `JWT_SECRET` where `payload.role !== 'customer'`, the `authenticateCustomer` middleware SHALL return HTTP 403 and SHALL NOT set `req.customer`. Conversely, *for any* JWT where `payload.role === 'customer'`, the middleware SHALL set `req.customer` to the decoded payload and call `next()`.

**Validates: Requirements 6.2, 6.5**

### Property 7: Refresh Token Replay Protection

*For any* customer refresh token family, once a token in that family has been used (rotated), presenting the same token again SHALL cause ALL tokens in the family to be revoked and SHALL return HTTP 401. No new access token SHALL be issued after a replay is detected.

**Validates: Requirements 3.7**

### Property 8: Profile Email Immutability

*For any* PUT request to `/api/customer/profile` that includes an `email` field in the request body, the customer's stored email address SHALL remain unchanged after the update. The response SHALL reflect the original email, not the value provided in the request body.

**Validates: Requirements 7.3, 7.4**

### Property 9: SSE Ownership Guard

*For any* SSE connection attempt to `/api/customer/jobs/:id/events`, the stream SHALL only be opened if `job.customer_id = req.customer.id` AND `job.company_id = req.customer.companyId`. If either condition fails, the endpoint SHALL return HTTP 403 and SHALL NOT open a streaming connection.

**Validates: Requirements 11.6, 11.7**

---

## Error Handling

### Backend Error Taxonomy

| Scenario | HTTP Status | Response Body |
|----------|-------------|---------------|
| Missing JWT | 401 | `{ message: "Not authenticated" }` |
| Invalid/expired JWT | 401 | `{ message: "Invalid or expired token" }` |
| JWT role !== 'customer' | 403 | `{ message: "Access denied" }` |
| Job not found / wrong owner | 404 | `{ message: "Job not found" }` |
| Invalid company code | 400 | `{ message: "Invalid company code" }` |
| Email already registered | 400 | `{ message: "Email already registered" }` |
| Email not verified | 403 | `{ message: "Email not verified. Please verify your email first." }` |
| OTP invalid/expired/used | 400 | `{ message: "Invalid or expired OTP. Please request a new one." }` |
| OTP rate limit exceeded | 429 | `{ message: "...", retryAfter: <seconds> }` |
| OTP cooldown (60s) | 429 | `{ message: "Please wait before requesting another OTP.", retryAfter: <seconds> }` |
| Company suspended | 403 | `{ message: "Account Suspended/Disabled" }` |
| Title missing on job create | 400 | `{ message: "Title is required" }` |
| Invalid priority value | 400 | `{ message: "Invalid priority value" }` |
| Tracking: no employee assigned | 200 | `{ available: false, reason: "No employee assigned yet" }` |
| Tracking: employee not accepted | 200 | `{ available: false, reason: "Employee has not accepted the job yet" }` |
| Tracking: no location data | 200 | `{ available: true, latitude: null, longitude: null, location_updated_at: null }` |
| Temp token expired (onboarding) | 401 | `{ message: "Session expired. Please sign in again." }` |
| Server error | 500 | `{ message: "Server error" }` |

### Frontend Error Handling

- All API errors are caught in axios interceptors and surfaced via a toast notification system.
- Form-level errors (validation failures) are displayed inline next to the relevant field.
- On 401 responses (excluding the refresh endpoint itself), the interceptor attempts one token refresh before redirecting to `/login`.
- SSE connection errors trigger a reconnect with exponential backoff (1s, 2s, 4s, max 30s).
- The Leaflet map component wraps its render in an error boundary to prevent map failures from crashing the job detail page.

### SSE Error Handling

- If Redis is unavailable, the SSE endpoint falls back to a long-poll approach: it sends a `{ type: 'connected' }` event and then closes the connection after 30 seconds, prompting the client to reconnect and re-fetch job state.
- On client disconnect (`req.on('close')`), the Redis subscriber is unsubscribed and the response object is removed from memory.

---

## Testing Strategy

### Unit Tests

Unit tests cover specific examples, edge cases, and error conditions for pure logic:

- `authenticateCustomer` middleware: valid token → sets req.customer; missing token → 401; wrong role → 403; expired token → 401.
- OTP generation: output is always a 6-digit numeric string.
- Job ownership filter: SQL query always includes both `customer_id` and `company_id` predicates.
- Profile update: email field is stripped from the UPDATE statement.
- Company code validation: valid code returns company name; invalid code returns `{ valid: false }`.
- JWT payload construction: access token always contains `{ id, role: 'customer', companyId, email }`.

### Property-Based Tests

Property-based tests use **fast-check** (TypeScript/JavaScript PBT library) with a minimum of **100 iterations** per property.

Each test is tagged with a comment in the format:
`// Feature: customer-portal, Property N: <property_text>`

**Property 1 — JWT Round-Trip Fidelity**
Generate arbitrary `{ id: uuid, role: 'customer', companyId: uuid, email: validEmail }` payloads. Sign with `JWT_SECRET`, verify, assert decoded payload fields match originals.
`// Feature: customer-portal, Property 1: JWT round-trip fidelity`

**Property 2 — Customer Job Ownership Isolation**
Seed the database with jobs belonging to multiple customers and companies. For any customer identity, assert that `GET /api/customer/jobs` returns only jobs satisfying both ownership predicates.
`// Feature: customer-portal, Property 2: customer job ownership isolation`

**Property 3 — Customer Job Creation Invariants**
Generate arbitrary valid job creation payloads (random title, description, priority). Assert the persisted row always has the five invariant fields set correctly.
`// Feature: customer-portal, Property 3: customer job creation invariants`

**Property 4 — Employee Location Access Control**
Generate combinations of (customerId, companyId, jobOwnerId, jobCompanyId, assignedTo). Assert that location data is only returned when all three conditions pass simultaneously.
`// Feature: customer-portal, Property 4: employee location access control`

**Property 5 — OTP Verification Round-Trip**
Generate random 6-digit OTPs. Store them, verify them, assert they are marked used. Assert second verification attempt returns 400.
`// Feature: customer-portal, Property 5: OTP verification round-trip`

**Property 6 — authenticateCustomer Role Enforcement**
Generate JWTs with arbitrary roles (owner, employee, admin, super_admin, random strings). Assert middleware returns 403 for all non-'customer' roles. Generate JWTs with role='customer' and assert middleware sets req.customer.
`// Feature: customer-portal, Property 6: authenticateCustomer role enforcement`

**Property 7 — Refresh Token Replay Protection**
Generate customer sessions. Issue refresh token, use it (rotate), present the old token again. Assert all tokens in the family are revoked and 401 is returned.
`// Feature: customer-portal, Property 7: refresh token replay protection`

**Property 8 — Profile Email Immutability**
Generate arbitrary profile update bodies including random email values. Assert stored email is unchanged after PUT.
`// Feature: customer-portal, Property 8: profile email immutability`

**Property 9 — SSE Ownership Guard**
Generate combinations of (requestingCustomerId, jobCustomerId, requestingCompanyId, jobCompanyId). Assert SSE stream opens only when both IDs match.
`// Feature: customer-portal, Property 9: SSE ownership guard`

### Integration Tests

Integration tests verify the wiring between components with 1–3 representative examples:

- Customer job created via `POST /api/customer/jobs` appears in `GET /api/v1/jobs` for the owner (verifies `visible_to_all = TRUE` integration).
- Employee accepting a job via `POST /api/v1/jobs/:id/accept` publishes to the correct Redis channel.
- SSE client receives `job_accepted` event after employee accepts the job (end-to-end Redis pub/sub test).
- Google OAuth callback creates a new customer row when email is new; links to existing row when email already exists.

### Smoke Tests

- `customers` table exists with all required columns after running migration SQL.
- `jobs` table has `customer_id`, `source`, `accepted_by` columns after migration.
- Customer portal CORS origins (`http://localhost:3001`, `https://client.prozync.in`) are present in `allowedOrigins`.
- `customer_access_token` cookie is set with `HttpOnly`, `SameSite=none`, `Secure` flags.
