# SmartERP Backend

Production-grade, multi-tenant enterprise resource planning (ERP) backend service built with Node.js, Express, PostgreSQL, Redis, and BullMQ.

SmartERP provides end-to-end automation for core business operations including multi-entity accounting, automated GST compliance, payroll computation, biometric/GPS attendance tracking, inventory control, and tenant-isolated AI business assistance.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Key Features & Modules](#key-features--modules)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Environment Configuration](#environment-configuration)
- [Database Migrations & Schema](#database-migrations--schema)
- [API Authentication & Security](#api-authentication--security)
  - [Employees API Security Requirements](#employees-api-security-requirements)
- [Testing & Quality Assurance](#testing--quality-assurance)
- [Documentation Index](#documentation-index)
- [Production Deployment](#production-deployment)
- [License](#license)

---

## Architecture Overview

SmartERP Backend is designed for high reliability, strict tenant isolation, and audit compliance:

- **Runtime & Web Tier:** Node.js (v18+) with Express.js REST API layer.
- **Data Tier:** PostgreSQL (v15+) with Row-Level Security (RLS) enforcement and connection pooling via `pg`.
- **Cache & Async Workers:** Redis and BullMQ for background job scheduling, rate limiting, and asynchronous processing.
- **Security & Authorization:** Role-based access control (RBAC), cryptographically signed JWT tokens, SHA-256 OTP hashing, and timing-safe secret comparisons.
- **AI & RAG Assistant:** Context-aware enterprise assistance with strict tenant data bounding and tool entitlements.

---

## Key Features & Modules

1. **Multi-Tenant Isolation:**
   - Middleware-enforced company context (`tenantContext.js`) on all protected endpoints.
   - Dual-layer data protection: application-level tenant filters and database-level Row-Level Security (RLS).
2. **Finance & GST Invoicing:**
   - Direct and walk-in invoice generation with distributed idempotency protection.
   - Dual-tax GST calculations (CGST, SGST, IGST), reverse charge mechanisms, and HSN/SAC summary breakdowns.
   - Automated AR aging and financial ledger reporting.
3. **HR & Attendance Management:**
   - Biometric and geofenced mobile attendance logging with automatic late and half-day status resolution.
   - Shift scheduling and salary calculation engines accounting for deductions, allowances, and attendance records.
4. **Subscription & Plan Enforcement:**
   - Multi-tier subscription controls (Free, Basic, Pro, Enterprise) gating module access and employee caps.
   - Webhook-verified payment reconciliation via Razorpay.
5. **AI Business Engine:**
   - Tenant-isolated conversational persistence and vector search (RAG) using pgvector.
   - Strict read-only policy enforcement preventing cross-tenant data exposure.

---

## Project Structure

```text
SmartERP-BackendEnd/
├── ai/                     # AI ReAct engine, plugins, and tool entitlement policies
├── config/                 # Service clients (Cloudinary, Firebase, Redis, etc.)
├── docs/                   # Structured documentation and architectural records
│   ├── architecture/       # System design specifications and ADRs
│   ├── archive/            # Historical implementation, migration, and audit reports
│   ├── operations/         # Production operational runbooks and rollout plans
│   ├── proposed-migrations/# Candidate and reviewed migration SQL scripts
│   └── security/           # Secret rotation, audit reports, and escalation guides
├── middleware/             # Tenant context, RBAC authentication, plan gatekeepers
├── migrations/             # Production schema migrations and migration runners
├── routes/                 # Express REST API route handlers
├── services/               # Core business logic services
├── tests/                  # Automated test suites (unit, security, migrations)
├── utils/                  # Concurrency limiters, date helpers, and sanitizers
├── Dockerfile              # Production container specification
├── docker-compose.yml      # Local orchestration with PostgreSQL and Redis
├── package.json            # Project dependencies and script declarations
├── README.md               # Backend guide and developer documentation
├── schema.sql              # Canonical baseline database schema
└── server.js               # Application entry point
```

---

## Prerequisites

- **Node.js**: v18.0.0 or later (LTS recommended)
- **PostgreSQL**: v15.0 or later (with `uuid-ossp` and `pgcrypto` extensions)
- **Redis**: v6.0 or later (required for queues and distributed caching)
- **Git**: Installed and configured

---

## Getting Started

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/PreethamGowda-B/SmartERP-BackendEnd.git
cd SmartERP-BackendEnd
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and configure your credentials:

```bash
cp .env.example .env
```

Review and adjust the environment variables described in the next section.

### 3. Initialize Database

Execute the baseline schema using `psql` or the npm runner:

```bash
# Using npm runner
npm run run-schema

# Or directly via psql
psql -h localhost -U <DB_USER> -d <DB_NAME> -f schema.sql
```

Run production migrations:

```bash
npm run migrate
```

### 4. Create Initial Administrator

```bash
# PowerShell
$env:ADMIN_EMAIL='admin@example.com'; $env:ADMIN_PASSWORD='StrongPassword123!'; npm run create-admin

# Bash
ADMIN_EMAIL='admin@example.com' ADMIN_PASSWORD='StrongPassword123!' npm run create-admin
```

### 5. Launch Application

```bash
# Development (with live reload)
npm run dev

# Production
npm start
```

Default server port is `4000` (or `PORT` specified in `.env`). Health check endpoint: `GET /health`.

---

## Environment Configuration

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | HTTP port for Express server | `4000` |
| `NODE_ENV` | Environment mode (`development`, `production`, `test`) | `development` |
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `JWT_SECRET` | Secret key for signing primary access tokens | Required |
| `JWT_REFRESH_SECRET` | Secret key for signing refresh tokens | Required |
| `REDIS_URL` | Redis connection URI | `redis://localhost:6379` |
| `RAZORPAY_KEY_ID` | Razorpay API key identifier | Optional (Payments) |
| `RAZORPAY_KEY_SECRET` | Razorpay API key secret | Optional (Payments) |
| `CLOUDINARY_URL` | Media storage connection URI | Optional (Uploads) |
| `FIREBASE_SERVICE_ACCOUNT` | JSON string or path for Firebase Admin SDK | Optional (Push) |

---

## Database Migrations & Schema

Database schema management follows strict forward-compatible migrations:

- `schema.sql`: Contains the canonical baseline structure of the SmartERP database.
- `migrations/`: Contains sequenced numerical migrations managed by `forwardMigrationRunner.js`.
- `docs/proposed-migrations/`: Contains reviewed draft migrations awaiting staging execution.

Run migrations safely with:

```bash
npm run migrate
```

---

## API Authentication & Security

All API routes outside of `/api/auth/login`, `/api/auth/register`, `/api/auth/otp`, and webhook receivers require an `Authorization: Bearer <token>` header.

### RBAC Hierarchy

1. **`super_admin`**: Global system monitoring and tenant management.
2. **`owner`**: Full administrative authority over company tenant resources, billing, and team permissions.
3. **`admin`**: Operational management (invoicing, inventory, manufacturing, HR).
4. **`hr`**: Human resources and attendance administration.
5. **`employee`**: Self-service portal access (assigned tasks, personal attendance, payslips).
6. **`customer`**: External client portal (invoice viewing, payment collection).

### Employees API Security Requirements

The `/api/employees` endpoints require a valid authenticated token and company context. Employee creation is limited to owner, admin, or HR roles and is subject to the current subscription employee limit. The application does not implement the previously documented `DEV_ALLOW_UNAUTH_USERS` bypass; do not add an unauthenticated employee mode for local testing.

---

## Testing & Quality Assurance

SmartERP utilizes Node.js's native test runner (`node:test`) for zero-dependency, deterministic test execution:

```bash
# Run core unit tests
npm test

# Run specific security and regression tests
node --test tests/unit.test.js tests/cncPhase2.test.js tests/phase5FinanceSecurity.test.js

# Run RLS and multi-tenant security verification
npm run test:rls

# Run full test suite
npm run test:all
```

---

## Documentation Index

Comprehensive platform architecture and operational guides are organized within the `docs/` directory:

- [System Architecture](file:///docs/architecture/ARCHITECTURE.md) (`docs/architecture/ARCHITECTURE.md`)
- [Platform Deep Dive](file:///docs/architecture/SmartERP_Platform_Documentation.md) (`docs/architecture/SmartERP_Platform_Documentation.md`)
- [AI Architecture & Roadmap](file:///docs/architecture/SMARTERP_AI_ARCHITECTURE_DECISION_RECORD_AND_IMPLEMENTATION_ROADMAP.md) (`docs/architecture/SMARTERP_AI_ARCHITECTURE_DECISION_RECORD_AND_IMPLEMENTATION_ROADMAP.md`)
- [Secret Rotation Protocol](file:///docs/security/SECRET_ROTATION_PROTOCOL.md) (`docs/security/SECRET_ROTATION_PROTOCOL.md`)
- [AI Security & Escalation Guide](file:///docs/security/AI_SECURITY_ESCALATION.md) (`docs/security/AI_SECURITY_ESCALATION.md`)
- [Payment Idempotency Rollout](file:///docs/operations/payment-idempotency-039-rollout.md) (`docs/operations/payment-idempotency-039-rollout.md`)
- [Subscription Migration Runbook](file:///docs/operations/subscription-migration-037-runbook.md) (`docs/operations/subscription-migration-037-runbook.md`)
- [Historical Audit Archive](file:///docs/archive/) (`docs/archive/`)

---

## Production Deployment

### Docker Deployment

A multi-stage, rootless `Dockerfile` is provided for production containerization:

```bash
# Build production image
docker build -t smarterp-backend:latest .

# Run container
docker run -d -p 4000:4000 --env-file .env.production --name smarterp-api smarterp-backend:latest
```

### Health Check

Verify service health and database connectivity:

```bash
curl -f http://localhost:4000/health
```

---

## License

Proprietary enterprise software. All rights reserved.
