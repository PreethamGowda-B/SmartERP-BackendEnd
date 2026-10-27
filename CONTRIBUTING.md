# Contributing to SmartERP Backend

Thank you for contributing to the SmartERP Backend. This guide outlines our architecture principles, testing standards, database migration rules, and pull request workflow.

---

## 1. Core Principles

- **Security & Multi-Tenant Isolation First:** Never trust client-supplied tenant identifiers. All database queries must be scoped by the authenticated user's `company_id`.
- **Database Migrations are Immutable:** Never modify an existing numbered migration after it has been executed on staging or production. Always write a forward migration.
- **Append-Only Ledgers are Protected:** Financial transactions, dispatches, and security logs are immutable append-only ledgers. Never run `UPDATE` or `FOR UPDATE` on tables where the application role lacks `UPDATE` privileges.
- **Fail Closed:** If authorization context, tenant ID, or signature verification is missing or invalid, reject immediately with HTTP 401/403/400.

---

## 2. Branching & Git Workflow

- **`main`**: Production deployment branch. Auto-deploys to Render production container on push.
- **`launch-hardening`**: Active stabilization, verification, and launch-readiness branch.
- **Topic Branches**: Branch off `launch-hardening` (or `main`) with standard prefixes:
  - `feat/<module-name>`
  - `fix/<issue-description>`
  - `perf/<optimization>`
  - `docs/<documentation>`

### Commit Standards
Follow [Conventional Commits](https://www.conventionalcommits.org/):
```
<type>(<scope>): <subject>

[detailed description]
```
Examples:
- `fix(production): remove FOR UPDATE locking from append-only inspection ledgers`
- `feat(ai): add next-version allocator function for active RLS documents`
- `test(security): add test asserting non-superuser NOBYPASSRLS app role`

---

## 3. Local Development Setup

### Prerequisites
- **Node.js**: `v20.x` or `v22.x` (LTS)
- **PostgreSQL**: `v15+` (local instance or Docker container)
- **Redis**: Local Redis server or Upstash instance
- **Docker** (optional): For running local `docker-compose.yml` stack

### Quickstart
```bash
# Clone repository
git clone https://github.com/PreethamGowda-B/SmartERP-BackendEnd.git
cd SmartERP-BackendEnd

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your local database and Redis credentials

# Run database schema / migrations (against your local test database)
# NEVER run untested migrations against shared or production instances!
psql -d smarterp_dev -f schema.sql

# Start development server
npm run dev
# Server starts on port 5000 (or PORT env)
```

---

## 4. Database & Migration Rules

1. **Numbered Migrations:** Place new SQL migrations under `migrations/` named sequentially (e.g. `046_feature_description.sql`).
2. **Transaction Blocks:** Always wrap migration DDL in `BEGIN; ... COMMIT;` with advisory locks to prevent concurrent application races.
3. **RLS Verification:** When creating tables containing tenant data:
   - Enable and FORCE Row-Level Security:
     ```sql
     ALTER TABLE public.table_name ENABLE ROW LEVEL SECURITY;
     ALTER TABLE public.table_name FORCE ROW LEVEL SECURITY;
     ```
   - Define strict policies for `smarterp_app` using `app.current_company_id`.
   - Grant only the minimum necessary privileges (`SELECT, INSERT`, etc.) to `smarterp_app`. Never grant `ALL` or `TRUNCATE`.
4. **Idempotency Verification:** Verify that migration scripts are idempotent and include post-condition checks (`DO $$ BEGIN ... END $$;`).

---

## 5. Testing & Verification

Every proposed change must be validated against our test suites before opening a Pull Request:

```bash
# 1. Run core unit tests (payroll, attendance, JWT auth, RBAC, tenant logic)
npm test

# 2. Run domain security and AI test suites
node --test tests/aiPersistence.test.js
node --test tests/aiPersistenceReadiness.test.js
node --test tests/aiDocumentPipeline.test.js
node --test tests/productionDispatchDomain.test.js
node --test tests/notification_security.test.js

# 3. Check for syntax and style issues
git diff --check
```

Never disable or comment out failing tests to force a build to pass. Address the root cause.
