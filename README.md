# SmartERP Backend (Prozync API)

[![Node.js](https://img.shields.io/badge/Node.js-22.x_LTS-green?style=flat&logo=node.js)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4.18.2-lightgrey?style=flat&logo=express)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B_with_RLS-336791?style=flat&logo=postgresql)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-Upstash_ioredis-DC382D?style=flat&logo=redis)](https://redis.io/)
[![BullMQ](https://img.shields.io/badge/BullMQ-5.41.3-orange?style=flat)](https://bullmq.io/)
[![License](https://img.shields.io/badge/License-Proprietary-red?style=flat)]()

Production-grade, multi-tenant Enterprise Resource Planning (ERP) backend service built with Node.js, Express, PostgreSQL, Redis, and BullMQ. SmartERP powers enterprise operations for small-to-medium manufacturing, precision CNC machining, and industrial field services.

---

## Table of Contents

1. [System Overview & Architecture](#1-system-overview--architecture)
2. [Verified Technology Stack](#2-verified-technology-stack)
3. [API Route & Module Inventory](#3-api-route--module-inventory)
4. [Authentication & Authorization Model](#4-authentication--authorization-model)
5. [Role-Based Access Control (RBAC) & Permissions](#5-role-based-access-control-rbac--permissions)
6. [Multi-Tenant Architecture & Company Isolation](#6-multi-tenant-architecture--company-isolation)
7. [Database Architecture, Schema & Migrations](#7-database-architecture-schema--migrations)
8. [Subscription Plans & Entitlement Enforcement](#8-subscription-plans--entitlement-enforcement)
9. [Core Business Modules](#9-core-business-modules)
10. [Background Jobs & Asynchronous Queues](#10-background-jobs--asynchronous-queues)
11. [AI Assistant, RAG & Document Lifecycle](#11-ai-assistant-rag--document-lifecycle)
12. [Storage, Email, Push & External Integrations](#12-storage-email-push--external-integrations)
13. [Environment Configuration](#13-environment-configuration)
14. [Local Development Setup](#14-local-development-setup)
15. [Testing Strategy & Test Execution](#15-testing-strategy--test-execution)
16. [API Health, Telemetry & Observability](#16-api-health-telemetry--observability)
17. [Deployment Architecture](#17-deployment-architecture)
18. [Backup, Recovery & Operational Runbooks](#18-backup-recovery--operational-runbooks)
19. [Security Controls & Known Limitations](#19-security-controls--known-limitations)
20. [Troubleshooting Guide](#20-troubleshooting-guide)
21. [Contributing Standards](#21-contributing-standards)
22. [License & Attribution](#22-license--attribution)

---

## 1. System Overview & Architecture

SmartERP Backend is designed for high reliability, zero data leakage across tenants, and strict financial compliance:

```
                                 [ Client Request ]
                                         │
                                         ▼
                            [ Cloudflare Edge / SSL ]
                                         │
                                         ▼
                  [ Express Web Server (api.prozync.in:5000) ]
       ┌─────────────────────────────────┴─────────────────────────────────┐
       ▼                                 ▼                                 ▼
 [ Security Shield ]             [ JWT Auth Guard ]              [ Tenant Context ]
 (Helmet, CORS, Rate Limit)      (Token verify, OTP hash)        (app.current_company_id)
       └─────────────────────────────────┬─────────────────────────────────┘
                                         ▼
                           [ Domain Route Dispatcher ]
  ┌───────────────┬───────────────┬───────────────┬───────────────┬──────────────┐
  ▼               ▼               ▼               ▼               ▼              ▼
[ Invoices ]   [ Jobs / CNC ]  [ Attendance ]  [ Payroll ]    [ AI Assistant ] [ Super Admin ]
  └───────────────┴───────────────┴───────────────┴───────────────┴──────────────┘
                                         │
                    ┌────────────────────┴────────────────────┐
                    ▼                                         ▼
      [ PostgreSQL 15+ Data Tier ]              [ Redis & BullMQ Queue ]
      - 48 Forward Migrations (57 SQL total)    - Async email dispatch (Resend)
      - Row-Level Security (RLS)                - Push notifications (FCM)
      - Append-Only Ledgers                     - Distributed locks & rate limits
      - Advisory Transaction Locks
```

---

## 2. Verified Technology Stack

| Layer | Technology | Version | Purpose in SmartERP |
| :--- | :--- | :--- | :--- |
| **Runtime** | Node.js | `22.x LTS` | Event-driven JavaScript runtime engine |
| **Web Framework** | Express.js | `4.18.2` | REST API routing, middleware chaining, and HTTP lifecycle |
| **Database** | PostgreSQL | `15+` | Primary relational data store with RLS and full-text search |
| **DB Client & Pool** | `pg` (node-postgres) | `8.11.0` | Connection pool manager with SSL mode auto-resolution |
| **Cache & Distributed KV** | Upstash Redis (`ioredis`) | `5.5.0` | Caching, session store, distributed rate limiting |
| **Job Queue** | BullMQ | `5.41.3` | Background asynchronous task processing |
| **Authentication** | `jsonwebtoken` / `bcrypt` | `9.0.0` / `5.1.0` | Cryptographic JWT signing and salted password hashing |
| **OAuth 2.0** | `passport-google-oauth20` | `2.0.0` | Google Single Sign-On integration |
| **Payments Gateway** | Razorpay SDK | `2.9.6` | Payment orders, webhook verification, and refunds |
| **Object Storage** | Cloudinary SDK | `1.41.3` | Document and image storage with secure signed URLs |
| **Transactional Email** | Resend SDK | `6.9.3` | Password reset OTPs, invoice delivery, and alerts |
| **Mobile Push** | Firebase Admin SDK | `13.6.1` | Push notifications to field employee devices |
| **AI LLM Inference** | Groq SDK (`groq-sdk`) | `0.7.0` | High-speed LLM inference for the conversational copilot |
| **Observability** | Sentry (`@sentry/node`) | `10.43.0` | Distributed error tracing and performance profiling |

---

## 3. API Route & Module Inventory

The API routes are mounted modularly in [`server.js`](file:///c:/Users/ADMIN/Desktop/SMARTERP/SmartERP-BackendEnd/server.js):

| Mount Path | Source File | Core Operations | Auth Required | Roles Permitted |
| :--- | :--- | :--- | :--- | :--- |
| `/api/auth` | `routes/auth.js` | Login, Register, Google OAuth, Refresh, Password Reset OTP | Partial (public endpoints) | All |
| `/api/owner` | `routes/owner.js` | Executive KPI dashboard, approvals, company settings | **Yes** | `owner`, `admin` |
| `/api/employees` | `routes/employees.js` | Employee CRUD, department assignments, salary profile | **Yes** | `owner`, `admin`, `hr` |
| `/api/jobs` | `routes/jobs.js` | Job creation, dispatch, customer linking, progress steps | **Yes** | `owner`, `admin`, `employee` |
| `/api/attendance`| `routes/attendance.js` | Clock-in/out, GPS check, late resolution, shift audits | **Yes** | All staff roles |
| `/api/payroll` | `routes/payroll.js` | Salary computation, bonus/deductions, pre-run audit | **Yes** | `owner`, `admin` |
| `/api/invoices` | `routes/invoices.js` | Direct/walk-in invoice generation, GST splits, payments | **Yes** | `owner`, `admin` |
| `/api/production`| `routes/production.js` | CNC work orders, quality inspections, dispatch ledgers | **Yes** | `owner`, `admin`, assigned staff |
| `/api/materials` | `routes/materials.js` | Inventory ledger, stock adjustments, purchase requests | **Yes** | `owner`, `admin`, `employee` |
| `/api/customer` | `routes/customer.js` | B2B service requests, machine history, invoice payments | **Yes** | `customer` |
| `/api/notifications` | `routes/notifications.js`| SSE notification stream, mark as read, event delivery | **Yes** | All authenticated |
| `/api/ai` | `routes/aiPersistence.routes.js` | RAG document ingestion, search, persistent chat sessions | **Yes** | `owner`, `admin` |
| `/api/superadmin`| `routes/superadmin.js` | Platform tenant management, health metrics, broadcast | **Yes** | `super_admin` |

---

## 4. Authentication & Authorization Model

1. **JWT Dual-Token Protocol:**
   - **Access Token:** Short-lived (15–60 minutes) containing `{ id, email, role, company_id }`.
   - **Refresh Token:** Rotated on use, stored as SHA-256 hash in database table `refresh_tokens`.
2. **Password & OTP Cryptography:**
   - Passwords hashed with `bcrypt` (10 rounds).
   - Password reset OTPs are hashed with SHA-256 before storage; raw OTPs are never stored in the database.
   - Verification uses `crypto.timingSafeEqual` to eliminate timing attacks.

---

## 5. Role-Based Access Control (RBAC) & Permissions

Roles are strictly hierarchical and enforced at the route level via [`middleware/authMiddleware.js`](file:///c:/Users/ADMIN/Desktop/SMARTERP/SmartERP-BackendEnd/middleware/authMiddleware.js):

| Capability / Action | `super_admin` | `owner` | `admin` | `hr` | `employee` | `customer` |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| Provision / Suspend Tenants | :white_check_mark: | :x: | :x: | :x: | :x: | :x: |
| Manage Company Financials & Invoices | :x: | :white_check_mark: | :white_check_mark: | :x: | :x: | :x: |
| Run Payroll & Salary Releases | :x: | :white_check_mark: | :white_check_mark: | :x: | :x: | :x: |
| Manage Staff & Attendance Adjustments | :x: | :white_check_mark: | :white_check_mark: | :white_check_mark: | :x: | :x: |
| Punch In/Out (GPS Clock-In) | :x: | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: | :x: |
| Execute Assigned Manufacturing Jobs | :x: | :white_check_mark: | :white_check_mark: | :x: | :white_check_mark: | :x: |
| View Owned Job Progress & Invoices | :x: | :x: | :x: | :x: | :x: | :white_check_mark: |
| AI RAG Document Management | :x: | :white_check_mark: | :white_check_mark: | :x: | :x: | :x: |

---

## 6. Multi-Tenant Architecture & Company Isolation

SmartERP implements a **shared database, pool-isolated schema** with dual-layer multi-tenancy:

1. **Application-Level Scoping:** Middleware extracts `company_id` from the authenticated JWT and automatically binds it to all SQL query parameters.
2. **Database-Level Row-Level Security (RLS):**
   - Tables enforce RLS:
     ```sql
     ALTER TABLE public.ai_documents ENABLE ROW LEVEL SECURITY;
     ALTER TABLE public.ai_documents FORCE ROW LEVEL SECURITY;
     ```
   - Request connections execute session context setup:
     ```sql
     SELECT set_config('app.current_company_id', $1, true);
     SELECT set_config('app.current_user_id', $2, true);
     SELECT set_config('app.current_role', $3, true);
     ```
   - Cross-tenant queries return 0 rows; cross-tenant writes trigger SQLSTATE `44501`.

---

## 7. Database Architecture, Schema & Migrations

- **Database Engine:** PostgreSQL 15+ (tested on PostgreSQL 17.6 on aarch64 Linux).
- **Migration Pipeline:** 48 forward numbered migrations (up to 046) plus 9 legacy/support scripts (57 SQL files total) in `migrations/` tracked by SHA-256 hashes in `app_migration_history`. Migration 046 establishes dedicated maintenance procedures for expired AI document and vector chunk retention.
- **Append-Only Ledger Tables:**
  - `production_inspections` & `production_dispatches`: Quality and dispatch ledgers.
  - Application role `smarterp_app` holds `SELECT, INSERT` privileges without `UPDATE` or `DELETE`, preventing ledger tampering.

---

## 8. Subscription Plans & Entitlement Enforcement

Feature gates are enforced via [`middleware/planMiddleware.js`](file:///c:/Users/ADMIN/Desktop/SMARTERP/SmartERP-BackendEnd/middleware/planMiddleware.js):

| Feature Key | Starter (Free) | Basic (Growth) | Pro (Scale) | Enterprise |
| :--- | :---: | :---: | :---: | :---: |
| Employee Seat Limit | 5 Seats | 25 Seats | 100 Seats | Unlimited |
| Finance & GST Invoices | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| Automated Payroll Engine | :x: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| CNC Machine Management | :x: | :x: | :white_check_mark: | :white_check_mark: |
| AI Business Copilot & RAG | :x: | :x: | :white_check_mark: | :white_check_mark: |

---

## 9. Core Business Modules

1. **Finance & GST Invoicing:** CGST/SGST (intra-state) vs IGST (inter-state), reverse charge, HSN/SAC summary tables, and payment recording with distributed idempotency protection.
2. **Production & CNC Dispatch:** Work order planning, quality inspections (accepted vs rework/scrap), packing records, and partial dispatch tracking.
3. **HR & Attendance:** Geofenced GPS coordinate verification, auto-detection of late arrivals and half-day thresholds, and manual clock-in adjustment approvals.
4. **Payroll Engine:** Deterministic calculation: `Net Salary = Base + Extra Allowances + Increments - Deductions (Late/Unpaid Leave)`.

---

## 10. Background Jobs & Asynchronous Queues

Managed by **BullMQ** over Redis with automatic exponential backoff:
- **Email Delivery:** Sending transactional emails asynchronously.
- **Push Notifications:** Firebase FCM message fan-out to employee mobile devices.
- **Scheduled Daily Audits:** `node-cron` triggers nightly attendance audits and AR overdue invoice reminders at midnight IST.

---

## 11. AI Assistant, RAG & Document Lifecycle

- **Architecture:** Document chunking, plain-text extraction, keyword/hybrid search via PostgreSQL tsvector and GIN indexes.
- **Active Version Isolation:** Migration 045 hides deleted, superseded, and expired records at the database RLS boundary.
- **Isolated Testing:** Complete verification plan specified in [`docs/security/AI_RLS_ISOLATED_POSTGRES_TEST_PLAN.md`](file:///c:/Users/ADMIN/Desktop/SMARTERP/SmartERP-BackendEnd/docs/security/AI_RLS_ISOLATED_POSTGRES_TEST_PLAN.md).

---

## 12. Storage, Email, Push & External Integrations

- **Cloudinary:** Document scans, PDF attachments, and employee avatar images.
- **Resend:** Transactional email gateway with verified SPF/DKIM records.
- **Firebase Admin (FCM):** Service account integration for mobile notifications.
- **Razorpay:** Payment order creation, webhook signature verification (`crypto.createHmac('sha256')`).

---

## 13. Environment Configuration

Copy `.env.example` to `.env` and populate configuration variables:

```bash
# Server Port & Environment
PORT=5000
NODE_ENV=development

# Database Configuration (PostgreSQL 15+)
DATABASE_URL=postgres://smarterp_app:your_password@localhost:5432/smarterp_dev
DB_SSL=false

# Redis Configuration (Upstash / Local)
REDIS_URL=redis://default:your_redis_password@localhost:6379

# JWT Cryptographic Secrets
JWT_SECRET=your-256-bit-jwt-access-secret-minimum-32-characters
JWT_REFRESH_SECRET=your-256-bit-jwt-refresh-secret-minimum-32-characters

# Frontend Origin for CORS Allowlists
FRONTEND_URL=http://localhost:3000

# Razorpay Payment Gateway (Test or Live Credentials)
RAZORPAY_KEY_ID=rzp_test_yourKeyId
RAZORPAY_KEY_SECRET=yourRazorpaySecret

# Transactional Email (Resend)
RESEND_API_KEY=re_yourResendApiKey
EMAIL_FROM=notifications@prozync.in

# Cloudinary Media Storage
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# AI Engine (Groq SDK)
GROQ_API_KEY=gsk_yourGroqApiKey
```

---

## 14. Local Development Setup

```bash
# 1. Clone repository
git clone https://github.com/PreethamGowda-B/SmartERP-BackendEnd.git
cd SmartERP-BackendEnd

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env

# 4. Initialize schema on your local PostgreSQL database
psql -d smarterp_dev -f schema.sql

# 5. Start development server
npm run dev
```

---

## 15. Testing Strategy & Test Execution

```bash
# 1. Run core unit tests (payroll, attendance, JWT auth, RBAC, tenant logic)
npm test
# Result: 84/84 tests pass

# 2. Run domain security & AI test suites
node --test tests/aiPersistence.test.js tests/aiPersistenceReadiness.test.js tests/aiDocumentPipeline.test.js tests/productionDispatchDomain.test.js tests/notification_security.test.js
# Result: 67/67 tests pass

# 3. Run all tests with force exit
npm run test:all
```

---

## 16. API Health, Telemetry & Observability

- **Health Endpoint:** `GET /health` returns server uptime, active database connection status, and Redis health.
- **Error Tracking:** Integrated Sentry middleware catches unhandled exceptions, sanitizes sensitive parameters, and forwards stack traces with tenant context.

---

## 17. Deployment Architecture

- **Hosting Platform:** Containerized deployment on **Render.com** (Docker) with custom domain routing at `api.prozync.in`.
- **Docker Build:** Multi-stage production [`Dockerfile`](file:///c:/Users/ADMIN/Desktop/SMARTERP/SmartERP-BackendEnd/Dockerfile) running as non-root user.
- **Edge Security:** Cloudflare DDoS mitigation, HTTP/3 (QUIC) edge support, and SSL termination.

---

## 18. Backup, Recovery & Operational Runbooks

- **Verified Backup Dump:** `C:\Users\ADMIN\Desktop\SMARTERP-BACKUP\smarterp-production-verified.dump` (SHA-256: `9223359362FE5F72595B58C3E7D9B16309C6984060C5957BE29A1DF9DEA6EC62`).
- **Operational Procedures:** Detailed runbooks in [`docs/operations/`](file:///c:/Users/ADMIN/Desktop/SMARTERP/SmartERP-BackendEnd/docs/operations/).

---

## 19. Security Controls & Known Limitations

- **Least Privilege Role:** `smarterp_app` possesses `NOSUPERUSER` and `NOBYPASSRLS`.
- **Append-Only Enforcement:** Inspection and dispatch ledger updates fail closed with SQLSTATE `42501` if attempted via the application role.
- **Known Limitation:** Deleting expired vector chunks requires the companion maintenance routine (`ai_purge_expired_retention`) detailed in [`docs/security/AI_RLS_ISOLATED_POSTGRES_TEST_PLAN.md`](file:///c:/Users/ADMIN/Desktop/SMARTERP/SmartERP-BackendEnd/docs/security/AI_RLS_ISOLATED_POSTGRES_TEST_PLAN.md).

---

## 20. Troubleshooting Guide

- **Database Connection Rejection (`ECONNREFUSED` / `SSL error`):**
  - Verify `DATABASE_URL` format. For cloud PostgreSQL (e.g. Supabase), set `DB_SSL=true`.
- **Payment Verification Failure:**
  - Verify `RAZORPAY_KEY_SECRET` matches your Razorpay webhook dashboard.

---

## 21. Contributing Standards

Review [`CONTRIBUTING.md`](file:///c:/Users/ADMIN/Desktop/SMARTERP/SmartERP-BackendEnd/CONTRIBUTING.md) and [`SECURITY.md`](file:///c:/Users/ADMIN/Desktop/SMARTERP/SmartERP-BackendEnd/SECURITY.md) before submitting code.

---

## 22. License & Attribution

Copyright &copy; 2026 SmartERP Technologies (Prozync). All rights reserved.<br>
Unauthorized copying, modification, or distribution is strictly prohibited.
