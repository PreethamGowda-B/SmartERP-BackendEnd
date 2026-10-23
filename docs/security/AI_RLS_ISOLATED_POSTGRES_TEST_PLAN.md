# AI RLS 044/045/046 Isolated PostgreSQL Test Plan & Lifecycle Security Specification

## Scope and Safety Notice

> [!IMPORTANT]
> **Reproducible Test Plan — Not Staging/Production Verification Evidence**
> No migration or database command was executed against the application's `.env` database, Supabase, staging, or production environments. This test plan specifies the exact execution steps, SQL test fixtures, and validation gates to run on a **freshly provisioned, isolated, disposable PostgreSQL database** containing no customer or business data.

- **Migration 044** is the additive schema baseline (creates tables, forced RLS, indexes, initial policies, and minimal `smarterp_app` grants).
- **Migration 045** is the active-version RLS hardening migration that refines the `USING` expressions of `ai_documents_owner_scope` and `ai_document_chunks_owner_scope` to hide deleted, superseded, and expired records at the database engine boundary.
- **Migration 046** is a separately reviewed, manual-only maintenance foundation. It creates a non-login RLS-bypass function owner and a separate non-login executor, with no scheduler membership configured. It purges only rows whose existing `retention_until` has passed, in bounded batches.
- Migration 046 adds two partial maintenance indexes for retention-deadline selection and supersession-chain predecessor lookup; the 044 baseline remains its original 10 indexes.
- **Rule of Isolation:** Do NOT apply Migrations 044, 045, or 046 to shared environments until every test case in this plan passes on an isolated test instance and required operational approvals are complete.

---

## 1. Disposable Environment Setup & Identity Gate

1. Provision a local disposable PostgreSQL 15+ database: `smarterp_ai_rls_test_<run_id>`.
2. Provision two distinct database roles:
   - `smarterp_admin`: Disposable superuser/owner used solely to run DDL and apply migrations.
   - `smarterp_app`: Non-superuser application runtime role with `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`.
3. Set `AI_RLS_TEST_DATABASE_URL` in the local test shell pointing to the disposable database.
4. Connect using the test URL and execute the Pre-Flight Identity Gate:

```sql
-- PRE-FLIGHT IDENTITY GATE (Run as test connection)
SELECT current_database() AS database_name,
       inet_server_addr() AS server_address,
       current_user AS connected_user,
       current_setting('server_version') AS server_version;

SELECT rolname, rolsuper, rolbypassrls, rolinherit
  FROM pg_roles
 WHERE rolname = 'smarterp_app';
```

**Pass Criteria:**
- `database_name` matches `smarterp_ai_rls_test_<run_id>`.
- `rolsuper` = `false`, `rolbypassrls` = `false`.
- Stop immediately if connected to any database name containing production, staging, supabase, or matching the application `.env`.

---

## 2. Apply Migrations & Verify Database Schema Baseline

Run the forward migration pipeline with `ON_ERROR_STOP=1`:

```powershell
# Run as disposable admin role
psql -X -v ON_ERROR_STOP=1 "$env:AI_RLS_TEST_DATABASE_URL" -f migrations/044_ai_rag_persistent_conversations.sql
psql -X -v ON_ERROR_STOP=1 "$env:AI_RLS_TEST_DATABASE_URL" -f migrations/045_ai_document_active_version_rls.sql
psql -X -v ON_ERROR_STOP=1 "$env:AI_RLS_TEST_DATABASE_URL" -f migrations/046_ai_document_retention_maintenance.sql
psql -X -v ON_ERROR_STOP=1 "$env:AI_RLS_TEST_DATABASE_URL" -f migrations/verify_ai_rag_044_045.sql
```

**Post-Migration Baseline Verification:**
1. Four AI tables exist in `public`: `ai_documents`, `ai_document_chunks`, `ai_conversations`, `ai_conversation_messages`.
2. Row-Level Security is enabled AND forced on all four tables (`relrowsecurity = true` AND `relforcerowsecurity = true`).
3. Ten expected indexes are present (including unique idempotency indexes).
4. Exactly four RLS policies exist in `pg_policies` for the four tables.
5. Role `smarterp_app` has minimal grants:
   - `ai_documents`: `SELECT, INSERT, UPDATE` (NO `DELETE`).
   - `ai_document_chunks`: `SELECT, INSERT, DELETE` (NO `UPDATE`).
   - `ai_conversations`: `SELECT, INSERT, UPDATE` (NO `DELETE`).
   - `ai_conversation_messages`: `SELECT, INSERT, UPDATE` (NO `DELETE`).

---

## 3. RLS Test Suite Matrix (Exercised as `smarterp_app`)

All tests in this section execute inside a transaction using `SET LOCAL ROLE smarterp_app;` and session settings via `set_config(..., true)`.

### 3.1 Valid Retention Predicates & Readiness Route Validation

- [ ] **Test 3.1.1 — Canonical Readiness Success:**
  Execute `schemaIsReady` / `GET /api/ai/readiness` with valid Owner context for `company-a`.
  - *Expected:* Readiness returns `ready: true`, HTTP 200.
  - *Verification:* The validator accepts `(retention_until IS NULL OR retention_until > now())` containing `OR` while verifying that exactly 4 strict policies exist.
- [ ] **Test 3.1.2 — Rejection of Missing Tenant Predicate:**
  Tamper with `ai_documents_owner_scope` to drop `company_id = NULLIF(...)`.
  - *Expected:* Readiness returns `ready: false`, persistence fails closed.
- [ ] **Test 3.1.3 — Rejection of 5th Permissive Policy:**
  Create a temporary permissive policy `test_broaden ON public.ai_documents FOR SELECT USING (true)`.
  - *Expected:* Readiness returns `ready: false` immediately; prevents OR-broadening vulnerability.
- [ ] **Test 3.1.4 — Rejection of Missing Retention Write Checks:**
  Tamper with `WITH CHECK` to omit `retention_until` boundary.
  - *Expected:* Readiness returns `ready: false`.

### 3.2 Cross-Company and Unauthorized-Role Denial

- [ ] **Test 3.2.1 — Cross-Company Read Isolation:**
  Seed active documents in `company-a` and `company-b`. Set context to `app.current_company_id = 'company-a'`, `app.current_role = 'owner'`.
  - *Query:* `SELECT id, company_id FROM public.ai_documents;`
  - *Expected:* Returns only `company-a` documents. Zero rows from `company-b`.
- [ ] **Test 3.2.2 — Cross-Company Write Rejection:**
  Set context to `company-a`. Attempt `INSERT INTO public.ai_documents (company_id, ...) VALUES ('company-b', ...)`.
  - *Expected:* Rejection with SQLSTATE `44501` (new row violates row-level security policy for table "ai_documents").
- [ ] **Test 3.2.3 — Unauthorized Staff Role Rejection (Employee / HR / Dispatch):**
  Set context to `company-a`, `app.current_role = 'employee'`.
  - *Read:* `SELECT * FROM public.ai_documents;` -> Returns 0 rows.
  - *Chunk Read:* `SELECT * FROM public.ai_document_chunks;` -> Returns 0 rows.
  - *Write:* `INSERT INTO public.ai_documents ...` -> Fails with `44501`.
  - *Expected:* Document management and RAG retrieval are strictly restricted to `owner` and `admin`.
- [ ] **Test 3.2.4 — Customer Role Rejection:**
  Set context to `company-a`, `app.current_role = 'customer'`.
  - *Expected:* Blocked from all four AI tables (0 rows on SELECT, `44501` on mutation).
- [ ] **Test 3.2.5 — Conversation User Ownership Isolation:**
  Seed conversation owned by `user-1` in `company-a`. Authenticate as `user-2` in `company-a`.
  - *Expected:* `user-2` cannot view, append messages to, or delete `user-1`'s conversation.

### 3.3 Active, Deleted, Superseded, and Expired Lifecycle Matrix

| Document State | Physical Columns | `ai_documents` SELECT | `ai_document_chunks` SELECT | `ai_documents` UPDATE | `ai_document_chunks` DELETE |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Active** | `deleted_at IS NULL`, `superseded_by IS NULL`, `retention_until > now()` | **Visible** | **Visible** | Allowed | Allowed |
| **Soft-Deleted** | `deleted_at IS NOT NULL` | **Hidden (0 rows)** | **Hidden (0 rows)** | Denied (`44501` or 0 rows) | **Blocked (0 rows)** |
| **Superseded** | `superseded_by IS NOT NULL` | **Hidden (0 rows)** | **Hidden (0 rows)** | Denied (`44501` or 0 rows) | **Blocked (0 rows)** |
| **Expired** | `retention_until <= now()` | **Hidden (0 rows)** | **Hidden (0 rows)** | Denied (`44501` or 0 rows) | **Blocked (0 rows)** |

- [ ] **Test 3.3.1 — Active Document Visibility:**
  Seed active ready document with chunks. Query documents and chunks as owner.
  - *Expected:* Document and chunks are visible and returned in keyword search.
- [ ] **Test 3.3.2 — Soft-Deleted Document Invisibility:**
  Set `deleted_at = now()`. Query as `smarterp_app`.
  - *Expected:* Neither document nor any of its chunks are returned.
- [ ] **Test 3.3.3 — Superseded Document Invisibility:**
  Set `superseded_by = <uuid>`. Query as `smarterp_app`.
  - *Expected:* Old document and its chunks are invisible. Only the new active version is returned.
- [ ] **Test 3.3.4 — Expired Document Invisibility:**
  Set `retention_until = now() - INTERVAL '1 minute'`. Query as `smarterp_app`.
  - *Expected:* Document and chunks are completely invisible to search, download, and list queries.

### 3.4 Re-Upload & Version Uniqueness Across Lifecycle States

- [ ] **Test 3.4.1 — Normal Monotonic Versioning in Active Family:**
  Upload version 1 into family `F1`. Ingest version 2 into `F1`.
  - *Expected:* Version 2 is assigned version 2. Version 1 is superseded by version 2. Old chunks are removed; new chunks are active.
- [ ] **Test 3.4.2 — Expired-Family Version Collision (The Core Problem):**
  Create family `F2` with version 1 (`retention_until` set in the past). All versions in `F2` are expired.
  - As `smarterp_app`, execute:
    `SELECT id, version FROM public.ai_documents WHERE document_family_id = 'F2' ORDER BY version DESC LIMIT 1 FOR UPDATE`
  - *Observation:* Returns 0 rows because Migration 045 RLS hides expired rows.
  - Attempt ingestion into `F2` starting at `version = 1`:
    `INSERT INTO public.ai_documents (..., version = 1) ON CONFLICT ON CONSTRAINT ai_documents_family_version_key DO NOTHING RETURNING ...`
  - *Verification:*
    1. First attempt encounters conflict on `ai_documents_family_version_key` (enforced at storage engine level). Returns 0 rows.
    2. Loop increments to `version = 2`.
    3. Version 2 succeeds and commits.
- [ ] **Test 3.4.3 — Bounded Conflict Exhaustion (Safety Limit):**
  Simulate 100 hidden/expired versions in a family. Attempt ingestion.
  - *Expected:* Ingestion attempts 100 increments, cleanly exhausts `MAX_DOCUMENT_VERSION_ALLOCATION_ATTEMPTS = 100`, rolls back the transaction, and rejects with HTTP 409 `AI_DOCUMENT_VERSION_ALLOCATION_EXHAUSTED`.
  - *Data Integrity:* Database connection is returned to pool without uncommitted state or locks held.
- [ ] **Test 3.4.4 — No privileged allocator path:** Verify that no version-allocation `SECURITY DEFINER` function exists and that `smarterp_app` cannot execute one. Version allocation uses application transactions, the company/family advisory lock, and the existing unique constraint; it must never read hidden history.

### 3.5 Chunk Cleanup After Deletion, Supersession, and Expiration

- [ ] **Test 3.5.1 — In-Band Soft-Deletion Chunk Ordering:**
  Execute `deleteDocument`:
  1. `DELETE FROM public.ai_document_chunks WHERE document_id = $1 AND company_id = $2;`
  2. `UPDATE public.ai_documents SET deleted_at = now() WHERE id = $1 AND company_id = $2;`
  - *Verification:* Chunks are successfully deleted because the parent document is still active during step 1.
- [ ] **Test 3.5.2 — Out-of-Order Deletion Failure (Known RLS Constraint):**
  Execute inverted sequence:
  1. `UPDATE public.ai_documents SET deleted_at = now() WHERE id = $1;`
  2. `DELETE FROM public.ai_document_chunks WHERE document_id = $1;`
  - *Observation:* Step 2 deletes **0 rows**! Because Migration 045's `USING` predicate requires `d.deleted_at IS NULL`. The chunks become permanent orphans under `smarterp_app`.
- [ ] **Test 3.5.3 — Inability of `smarterp_app` to Clean Expired Chunks:**
  Seed expired document (`retention_until <= now()`) with chunks.
  - Attempt as `smarterp_app`: `DELETE FROM public.ai_document_chunks WHERE document_id = $1;`
  - *Observation:* Deletes **0 rows**.
  - Attempt as `smarterp_app`: `DELETE FROM public.ai_documents WHERE id = $1;`
  - *Observation:* Fails with SQLSTATE `42501` (permission denied for table ai_documents; app role lacks DELETE).
- [ ] **Test 3.5.4 — Dedicated Maintenance Purge Procedure Execution:**
  Only after migration 046 is separately approved and installed in the disposable database, invoke `smarterp_ai_maintenance.purge_expired_documents(100)` through a login explicitly granted membership in `smarterp_ai_retention_executor`.
  - *Expected:* The function deletes at most 100 chunk and document rows combined, only for documents whose stored `retention_until` has elapsed, deleting chunks before eligible parent rows. It returns counts only.
  - *Verification:* A repeated invocation is safe; rows with NULL/future retention deadlines remain. This does not prove an automatic schedule exists.

### 3.6 Re-Indexing and Processing Transitions

- [ ] **Test 3.6.1 — Re-Index State Lifecycle:**
  Execute re-index on active document `D1`:
  1. Takes advisory xact lock `ai-doc:<company>:<family>`.
  2. Transitions `processing_status = 'processing'`, increments `processing_attempts`.
  3. Purges old chunks: `DELETE FROM public.ai_document_chunks WHERE document_id = D1;`
  4. Inserts new chunks.
  5. Transitions `processing_status = 'ready'`, sets `processed_at = now()`.
  - *Expected:* Complete transition succeeds; all new chunks searchable.
- [ ] **Test 3.6.2 — Re-Index Rollback on Chunk Failure:**
  Inject a failure during step 4 of re-indexing (e.g. invalid chunk data or interrupted connection).
  - *Expected:* Transaction rolls back. Prior chunks remain intact. Document status remains in prior valid state.
- [ ] **Test 3.6.3 — Re-Index Competing Version Supersession:**
  Re-index an older version (v1) while a higher version (v2) is already ready.
  - *Expected:* v1 chunks are purged; v1 is marked `superseded_by = v2`. v2 remains the active document.

---

## 4. Concrete SQL Test Fixture Scripts

Run these scripts sequentially in `psql` against the disposable database.

### Fixture A: Tenant & Role Denial Check

```sql
BEGIN;
-- Setup synthetic data as admin
INSERT INTO public.users (id, email, password_hash, role)
VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 'owner@a.com', 'hash', 'owner'),
       ('00000000-0000-0000-0000-000000000002'::uuid, 'emp@a.com', 'hash', 'employee');

INSERT INTO public.ai_documents (id, company_id, uploaded_by, title, original_filename, media_type, processing_status)
VALUES ('11111111-1111-1111-1111-111111111111'::uuid, 'comp-a', '00000000-0000-0000-0000-000000000001'::uuid, 'Doc A', 'doc.txt', 'text/plain', 'ready'),
       ('22222222-2222-2222-2222-222222222222'::uuid, 'comp-b', '00000000-0000-0000-0000-000000000001'::uuid, 'Doc B', 'doc.txt', 'text/plain', 'ready');

-- Switch to app role with Employee context
SET LOCAL ROLE smarterp_app;
SELECT set_config('app.current_company_id', 'comp-a', true);
SELECT set_config('app.current_user_id', '00000000-0000-0000-0000-000000000002', true);
SELECT set_config('app.current_role', 'employee', true);

-- Employee must see 0 documents
DO $$
BEGIN
  IF (SELECT count(*) FROM public.ai_documents) <> 0 THEN
    RAISE EXCEPTION 'TEST FAILED: Employee saw documents';
  END IF;
END $$;

-- Switch to Owner context for comp-a
SELECT set_config('app.current_role', 'owner', true);
SELECT set_config('app.current_user_id', '00000000-0000-0000-0000-000000000001', true);

-- Owner must see only comp-a document
DO $$
BEGIN
  IF (SELECT count(*) FROM public.ai_documents) <> 1
     OR (SELECT company_id FROM public.ai_documents) <> 'comp-a' THEN
    RAISE EXCEPTION 'TEST FAILED: Owner did not get exact comp-a document';
  END IF;
END $$;

ROLLBACK;
```

### Fixture B: Expired Family Version Collision Check

```sql
BEGIN;
-- Setup family with expired version 1
INSERT INTO public.users (id, email, password_hash, role)
VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 'owner@a.com', 'hash', 'owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.ai_documents (
  id, company_id, uploaded_by, document_family_id, version,
  title, original_filename, media_type, processing_status,
  retention_until
)
VALUES (
  '33333333-3333-3333-3333-333333333333'::uuid, 'comp-a',
  '00000000-0000-0000-0000-000000000001'::uuid,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 1,
  'Old Policy', 'policy.txt', 'text/plain', 'ready',
  now() - INTERVAL '1 day' -- EXPIRED
);

SET LOCAL ROLE smarterp_app;
SELECT set_config('app.current_company_id', 'comp-a', true);
SELECT set_config('app.current_user_id', '00000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.current_role', 'owner', true);

-- App role cannot see expired version 1
DO $$
DECLARE
  v_visible_count INTEGER;
BEGIN
  SELECT count(*) INTO v_visible_count
    FROM public.ai_documents
   WHERE document_family_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;

  IF v_visible_count <> 0 THEN
    RAISE EXCEPTION 'TEST FAILED: Expired document was visible under RLS';
  END IF;
END $$;

-- Re-upload attempting version 1 encounters unique conflict
-- App loop tries version 2 and succeeds
DO $$
DECLARE
  v_inserted_id UUID;
BEGIN
  INSERT INTO public.ai_documents (
    company_id, uploaded_by, document_family_id, version,
    title, original_filename, media_type, processing_status
  )
  VALUES (
    'comp-a', '00000000-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 1,
    'New Policy', 'policy.txt', 'text/plain', 'processing'
  )
  ON CONFLICT ON CONSTRAINT ai_documents_family_version_key DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: Collision on version 1 was not detected by unique constraint';
  END IF;

  -- Second attempt with version = 2 succeeds
  INSERT INTO public.ai_documents (
    company_id, uploaded_by, document_family_id, version,
    title, original_filename, media_type, processing_status
  )
  VALUES (
    'comp-a', '00000000-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 2,
    'New Policy', 'policy.txt', 'text/plain', 'processing'
  )
  ON CONFLICT ON CONSTRAINT ai_documents_family_version_key DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RAISE EXCEPTION 'TEST FAILED: Version 2 insert failed';
  END IF;
END $$;

ROLLBACK;
```

---

## 5. Architectural Evaluation & Go / No-Go Decision

### Current Recommendation: **NO-GO FOR MANUAL APPLICATION**

The source candidate retains the 044 uniqueness contract and uses a bounded, company/family-serialized insert probe. A 100-conflict ceiling remains because the application cannot inspect hidden historical versions and no separately authorized/tested database allocator exists. Exhaustion returns a predictable HTTP 409; it does not expose historical metadata or weaken RLS.

Migration 046 adds a not-yet-registered, not-yet-executed bounded purge foundation. It deletes only rows whose existing `retention_until` has elapsed, deletes chunks before parent rows, respects the supersession self-FK by processing oldest chain roots, and leaves NULL/future deadlines untouched. It does not define an approved longer post-deletion retention interval. The function is not scheduled. A scheduler identity and operational run cadence require separate review and approval.

Neither migration 045 nor 046 is approved for manual application until the complete migration sequence and RLS/lifecycle tests pass on a positively identified disposable PostgreSQL database. This candidate has not performed those database tests.

---

## 6. Evidence Capture Checklist

> [!NOTE]
> Mark all test results as **NOT TESTED** until physically executed against the disposable database.

- [ ] Disposable PostgreSQL version: `[NOT TESTED]`
- [ ] Role flags verification (`smarterp_app` `NOBYPASSRLS`): `[NOT TESTED]`
- [ ] 044 migration exit code 0: `[NOT TESTED]`
- [ ] 045 migration exit code 0: `[NOT TESTED]`
- [ ] `verify_ai_rag_044_045.sql` output: `[NOT TESTED]`
- [ ] Fixture A (Tenant & Role Denial): `[NOT TESTED]`
- [ ] Fixture B (Expired Family Collision): `[NOT TESTED]`
- [ ] Backend readiness route HTTP 200: `[NOT TESTED]`
- [ ] No credentials, secrets, or production data logged: `VERIFIED`

---

## 7. Current Candidate Corrections and Required PostgreSQL Evidence

This section is the authoritative implementation note. The candidate allocates versions under the existing company/family transaction advisory lock by probing the 044 unique constraint with `ON CONFLICT ON CONSTRAINT ai_documents_family_version_key DO NOTHING`. It does not query hidden document metadata. A bounded 100-attempt ceiling is deliberately retained: without PostgreSQL evidence and a separately reviewed allocator that can safely initialize from hidden history, an unbounded probe loop could create excessive work. After 100 consecutive conflicts the request fails predictably with HTTP 409 `AI_DOCUMENT_VERSION_ALLOCATION_EXHAUSTED`; the integer boundary has its own HTTP 409 `AI_DOCUMENT_VERSION_EXHAUSTED`. An isolated PostgreSQL test is still required to prove how the unique index and RLS interact under the restricted role.

### 7.1 Version allocation test cases

- [ ] Seed more than 100 consecutive historical versions hidden by expiry/supersession. As `smarterp_app`, run the real repository upload path and confirm it makes at most 100 unique-index probes, returns `AI_DOCUMENT_VERSION_ALLOCATION_EXHAUSTED`, rolls back, and returns no hidden version metadata.
- [ ] Run concurrent uploads for the same company and family using separate app-role connections. Confirm the family advisory lock serializes cooperating requests, every committed version is unique, and retries never cross the company key.
- [ ] Seed a visible latest version `2147483647` as a privileged test fixture and confirm the application returns `AI_DOCUMENT_VERSION_EXHAUSTED` without integer overflow or data mutation. Also document the unresolved case where all historical versions are hidden and the maximum integer is occupied; the bounded 100-attempt result remains the safe response.
- [ ] Separately test replay of an ingest request key held by an RLS-hidden historical row. Migration 044's `idx_ai_documents_ingest_request` is a different unique index; the business policy for reuse/expiry of request keys remains unresolved and must not be bypassed by the version allocator.

### 7.2 Lifecycle and maintenance test cases

- [ ] Active, deleted, superseded, and expired documents: test both document and direct chunk SELECT under Owner, Admin, Employee, Customer, and a different company context. Only active/unexpired documents and same-company chunks should be visible to Owner/Admin.
- [ ] Soft deletion via application path: verify chunks are deleted first and the document tombstone is written second in the same transaction. Inject a failure between operations and confirm rollback leaves the active document/chunks consistent.
- [ ] Supersession via ingestion and re-index: confirm retiring-version chunks are deleted before `superseded_by` is set; after the transition, direct RLS reads return no old document/chunks. Inject a failure and confirm transaction rollback.
- [ ] Processing transitions: verify ready -> processing -> ready and failure/rollback cases; do not let a failed re-index expose partial chunks or make a superseded/deleted document visible.
- [ ] Migration 046 retention boundaries: NULL or future `retention_until` rows remain; elapsed retention rows (active, soft-deleted, or superseded) may be physically removed. No additional fixed grace interval is added; a soft-deleted row whose stored retention deadline is still future must remain.
- [ ] Purge batch limit: with more than 500 eligible chunks/documents, call `smarterp_ai_maintenance.purge_expired_documents(500)` and confirm no more than 500 total rows are deleted (chunks plus parents combined); verify chunk identifiers and company keys are paired to the locked parent candidates.
- [ ] Supersession chains: the maintenance query selects chain roots only, honors the 044 self-FK `ON DELETE RESTRICT`, and successive bounded runs remove later versions only after predecessors are gone.
- [ ] Function privileges: confirm the function owner is NOLOGIN/NOSUPERUSER/BYPASSRLS with DELETE plus column-level SELECT only for document retention/relationship keys and chunk parent/company keys (never text/content); executor is NOLOGIN/NOSUPERUSER/NOBYPASSRLS; `smarterp_app`, PUBLIC, and application roles cannot execute it or assume either role; no role membership is present until the scheduler integration receives separate approval.
- [ ] Batching and concurrency: reject limits outside 1..500; run two maintenance calls concurrently and confirm `FOR UPDATE SKIP LOCKED`, transaction atomicity, accurate counts, and safe repeated invocation.
- [ ] Failure/rerun: force migration 046 to fail before COMMIT and verify transaction rollback leaves no partial roles/schema/function. A successful repeat execution intentionally stops at the existing-object precondition; inspect state rather than rerunning it blindly.

### 7.3 Required command sequence

Only in a newly created, positively identified disposable local database, after capturing its identity and PostgreSQL version:

```powershell
psql -X -v ON_ERROR_STOP=1 "$env:AI_RLS_TEST_DATABASE_URL" -f migrations/044_ai_rag_persistent_conversations.sql
psql -X -v ON_ERROR_STOP=1 "$env:AI_RLS_TEST_DATABASE_URL" -f migrations/045_ai_document_active_version_rls.sql
psql -X -v ON_ERROR_STOP=1 "$env:AI_RLS_TEST_DATABASE_URL" -f migrations/046_ai_document_retention_maintenance.sql
psql -X -v ON_ERROR_STOP=1 "$env:AI_RLS_TEST_DATABASE_URL" -f migrations/verify_ai_rag_044_045.sql
node --test tests/aiPersistenceReadiness.test.js tests/aiPersistence.test.js tests/aiRlsHardeningMigration.test.js tests/aiRetentionMaintenanceMigration.test.js
```

Use synthetic fixtures only. Execute the RLS cases by `SET ROLE smarterp_app` with transaction-local context, and execute the purge tests only through the separately approved maintenance executor. Do not use the main `.env`, Supabase, staging, production, or any database whose disposable identity is uncertain. The current machine has no `psql`, PostgreSQL server tools, Docker, or Podman available; the PostgreSQL portion remains **NOT TESTED** here.
