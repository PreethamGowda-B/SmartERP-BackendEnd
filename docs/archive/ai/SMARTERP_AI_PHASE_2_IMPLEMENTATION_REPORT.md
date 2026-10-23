# SmartERP AI Phase 2 — Safe Source Work and Integration Gates

**Status: IMPLEMENTATION — database and embedding integration are not active.**

**Migration authorization:** An additive review draft is approved only. This does not authorize migration registration or execution.

**Pending owner decisions:** The owner will specify document access/ACL policy and the approved embedding provider/model. Until those decisions are made, document controls remain Owner/Admin-only and company-scoped, while semantic/vector search remains disabled.

## Repository baseline

- Backend and frontend are on branch `launch-hardening`.
- The backend already contains uncommitted AI authorization/entitlement work and an invoice-list type-compatibility fix. The frontend contains the uncommitted direct-invoice-modal responsive redesign and its test. These changes were preserved.
- No production database, payment provider, external embedding provider, or migration was accessed or changed for this phase.

## Source findings

- The active chat endpoint is authenticated and subscription-gated at `routes/ai.routes.js`; the current specialist tool registry has separate role, company-context, model-scope, and plan entitlement guards.
- The active frontend is `components/smart-ai-panel.tsx`. It currently keeps chat history in user-keyed browser `localStorage` and sends message history to `/api/ai/agent`.
- `ai/rag/rag.service.js` is a disconnected static string matcher, not a document retrieval pipeline.
- `migrations/004_internal_messaging.sql` creates generic messaging tables. They do not provide the AI thread owner/title, message role, citation metadata, request idempotency, retention, and document ACL behavior required here. They were not repurposed.
- Existing employee document upload uses Cloudinary/database media storage and employee-document access semantics. It is not a safe drop-in knowledge-base store without a distinct policy and schema.
- The current backend dependencies do not include a PDF or DOCX text extractor. No embedding adapter is configured in the existing provider factory; the Groq chat adapter is not assumed to implement embeddings.
- The tracked schema and production evidence in prior reports have differing company ID types. No live schema was queried in this task; a schema migration must use a reviewed compatibility contract.

## Implemented source-only groundwork

- `services/aiDocumentPipeline.js` adds bounded UTF-8 TXT/Markdown ingestion, SHA-256 content hashes, configurable overlapping chunks, keyword ranking, optional provider-neutral embedding similarity and reranking interfaces, tenant/document ACL filtering before ranking, citation metadata, safe provider errors, and an explicit untrusted-document context formatter.
- PDF and DOCX return a clear unsupported-format error until an approved parser dependency is selected and tested. No parser or paid service was added.
- `services/aiConversationPolicy.js` adds reusable user-plus-company ownership checks, bounded pagination, and retention-date validation for a future persistent conversation repository.
- Tests cover malformed/oversized/unsupported input, chunking and content-hash generation, company and document filtering, deletion/superseded filtering, hybrid ranking and source citations, prompt-injection text handling, missing evidence, provider errors, and conversation ownership/pagination. Database-backed duplicate-ingestion idempotency remains unimplemented.

These helpers are currently **not wired to upload/retrieval routes, the AI prompt, or persistent database tables**. They do not activate RAG or server-side conversation history by themselves.

## Review-only migration draft

An additive SQL draft now exists at `docs/proposed-migrations/044_ai_rag_persistent_conversations.sql`. It is outside the runner's `migrations/` directory and is **not registered, executed, or verified against PostgreSQL**. It provides:

- Company-scoped documents and chunks, processing state, content hash/version, extracted text, deletion/supersession markers, source metadata, and full-text GIN indexing.
- Optional JSONB embedding slots with model and dimension metadata; no vector extension and no semantic-search activation.
- User-owned conversations/messages, ordered history indexes, citation metadata, and unique user-message request keys for idempotency.
- Forced RLS and minimum `smarterp_app` grants. Document/chunk access is Owner/Admin-only and company-scoped; conversation/message access is user-and-company scoped. The draft uses `company_id TEXT` because company-key types vary across available source/schema snapshots; it intentionally avoids a company FK until the target contract is confirmed.
- Fail-closed checks for required tables, columns, named constraints, indexes, RLS policies, and app-role safety. It creates no migration-runner entry.

The migration has not been parsed or run by PostgreSQL; its SQL remains a review draft. Its `company_id TEXT` choice is still unverified against the actual target's company identifiers and must be reconciled before registration.

Document contents can include confidential business data. The proposed initial policy is Owner/Admin only, restricted to their own company; employee/customer access remains excluded until document-level ACLs exist. The policy helper explicitly checks upload, list, search, re-index, download, and delete actions, but no routes call it yet. Reuse of Cloudinary for the raw file is not assumed; extracted text retention in the database requires a privacy/retention decision.

## Integration-readiness review and source changes

- Authenticated middleware establishes `req.user`, then `setTenantContext` places user ID, company ID, role, and bypass flag in AsyncLocalStorage. It now accepts the authenticated identity's `id` or `userId` alias.
- `db.js` reads that context at every pool checkout. It now validates UUID user IDs, parameterizes all four session settings, resets role/settings for each checkout, and always switches non-bypass requests to `smarterp_app`, even when company context is missing. A failed role switch now aborts checkout rather than continuing as the database owner. Mock tests verify sequential tenant/user contexts, clearing on context-free checkout, and failure behavior.
- A remaining risk is in `tenantContext.js`: it sets `bypassRls` when a user has no company ID. This supports existing onboarding/auth paths but is broader than an explicit bypass. Those paths and their query behavior need a route-by-route security review before persistent RLS-backed AI storage is enabled.
- `company_id TEXT` is only a compatibility proposal. Source/runtime snapshots support both numeric and UUID company identifiers, and no live schema was inspected. Confirm target column types and equality/FK contracts on an isolated database before deciding whether text or a typed key is correct.
- `services/aiDocumentAccessPolicy.js` enforces Owner/Admin-only company access for each planned document operation, filters deleted/superseded documents, and does not activate routes. `searchHybrid` now requires that role/company policy and removes cross-company, deleted, and superseded content before ranking.
- Keyword mode is the default. Supplying an embedding adapter alone does not call it; semantic ranking requires an explicit opt-in flag, and no active route sets that flag. No external embedding provider was called. The provider-neutral interface needs an approved provider/model, data-handling approval, vector dimensions, credentials/configuration, timeout/retry policy, and usage/cost controls before it can be enabled.
- The owner/admin document policy and current schema draft have only unit/mock coverage. Actual role behavior, forced RLS, and grants remain unverified until tested as the non-superuser `smarterp_app` role in an isolated PostgreSQL database.

## Required provider/configuration decisions

- Select an approved embedding provider and model, including its data-handling approval, vector dimensions, timeout, retry, and usage limits. If none is approved, keyword retrieval can run but semantic/hybrid retrieval remains disabled and clearly identified as keyword-only.
- Select approved PDF/DOCX parsers or accept TXT/Markdown-only ingestion for the first release.
- Approve conversation/document retention duration and whether user deletion removes content immediately or through a bounded retention purge.

## Verification

- Focused AI and context suite with `REDIS_URL` cleared: `node --test tests/rlsContextPropagation.test.js tests/aiDocumentPipeline.test.js tests/aiConversationPolicy.test.js tests/aiFastPathPolicy.test.js tests/aiFastPathRouteAuthorization.test.js tests/aiToolEntitlements.test.js tests/aiAssignedJobs.test.js tests/aiAttendanceSummaryAccess.test.js tests/planMiddlewareFallback.test.js` — **55 passed, 0 failed**. Mocked clients and unit/source tests only; no PostgreSQL, RLS, embedding provider, upload storage, or live model is used.
- `node --test tests/direct-invoice-modal-responsive.test.mjs` in the frontend — **8 passed, 0 failed**. This is a source-level modal test and does not constitute visual browser verification.
- Backend `git diff --check` — passed.

## Remaining work

1. Specify document-reader roles/sharing, ACL rules, retention and deletion behavior, and approved document types/parsers.
2. Review the draft and database type assumptions; test `app.current_user_id` and the Owner/Admin document policy under the non-superuser app role.
3. Select/configure an approved embedding provider/model; only then activate semantic search and add provider-backed tests.
4. Add migration-backed repositories/routes for upload, list, process/retry, re-index, search, deletion, and conversation create/list/open/continue/delete.
5. Wire retrieval into the active `/api/ai/agent` prompt as untrusted evidence with citations, preserving live ERP tools and authorization checks.
6. Integrate the current AI panel with server-backed conversation history, document controls, processing states, and citations.
7. Run isolated PostgreSQL/RLS tests, then approved browser and staging verification. Those environments were unavailable/not used in this phase.

No production readiness or runtime behavior is claimed.

## Implementation update — 2026-10-23

This section supersedes the earlier “not wired” status above for the current source candidate. It does not claim deployment, database activation, PostgreSQL validation, or production readiness.

### Current source implementation

- The authenticated `/api/ai` persistence router is mounted by `server.js`. It exposes a capability probe; conversation create/list/open/rename/soft-delete; and document list/upload/read/search/reindex/soft-delete. The `/agent` route uses conversation-turn middleware when a conversation ID is supplied. Requests require authenticated identity, company context, subscription feature access, and an explicitly enabled persistence configuration.
- Conversation records and messages use company plus authenticated-user predicates in repository SQL. Create and message requests use idempotency keys with payload fingerprints; exact completed retries replay the saved response, while a changed payload under the same key is rejected. Ownership, bounded pagination, and retention filters are applied by the repository.
- Document ingestion supports UTF-8 TXT and Markdown only, with a 5 MB upload limit, content hash, bounded chunking, version families, processing status, retries/reindex, soft deletion, and active-version filtering. Document list/read/search/upload/reindex/delete are Owner/Admin-only and company-scoped. Chunk retrieval includes company and active document conditions in SQL. Document retrieval is keyword/full-text only; it does not call an embedding provider.
- `/agent` can include authorized document evidence for Owner/Admin requests. Retrieved content is labeled as untrusted evidence and is separate from live ERP tools. Document-only mode advertises no ERP tools and rejects any provider-returned tool call. Citations are accepted only when their tokens match retrieved company-scoped chunks; a response with no valid citation is replaced with a safe no-verified-citation response.
- `components/smart-ai-panel.tsx` now probes backend capabilities and uses server-backed conversations/document controls only when the API explicitly reports readiness and conversation history loads. Otherwise the existing browser-history fallback remains available. The panel provides server history, conversation controls, TXT/Markdown upload, status, keyword search, reindex/delete, and citation display.
- `docs/proposed-migrations/044_ai_rag_persistent_conversations.sql` remains a review draft under `docs/proposed-migrations/`. It is not in the migration runner and was not executed. Runtime persistence stays disabled unless configuration and a schema/RLS/role/grant preflight both pass.

### Verification performed

- Backend syntax checks: `node --check services/aiPersistence.js`, `routes/aiPersistence.routes.js`, `routes/ai.routes.js`, `ai/planner/ReAct.engine.js`, and `server.js` — passed.
- Backend mocked/unit suite with `REDIS_URL` cleared: `node --test tests/aiPersistence.test.js tests/aiDocumentPipeline.test.js tests/aiConversationPolicy.test.js tests/rlsContextPropagation.test.js tests/aiFastPathPolicy.test.js tests/aiFastPathRouteAuthorization.test.js tests/aiToolEntitlements.test.js tests/aiAssignedJobs.test.js tests/aiAttendanceSummaryAccess.test.js tests/planMiddlewareFallback.test.js` — 67 passed, 0 failed. One test fixture initially failed before reaching the intended assertion because the context prompt was missing; the fixture now supplies a system-prompt override and the suite passes. A few expected test cases log simulated failures; these are not suite failures.
- Frontend `npx tsc --noEmit` — passed.
- Frontend `npm run build` — passed. Next.js emitted existing lint warnings in other pages/components; build and type validation completed successfully.
- Frontend `node --test tests/direct-invoice-modal-responsive.test.mjs` — 12 passed, 0 failed (pre-existing invoice-modal test, retained; not browser visual verification).
- `git diff --check` — passed in both repositories.

These checks are local syntax, source, and mocked/unit verification. No PostgreSQL instance, migration parser, isolated database, browser, staging service, or production service was used. The draft SQL therefore has not been validated by PostgreSQL.

### Remaining gates and limitations

1. Confirm the actual target schema contract (especially `companies.id` / `company_id`, `users.id`, existing roles, and UUID/text compatibility) from an explicitly isolated database. The current draft uses `company_id TEXT`; this remains a proposal, not a verified schema match.
2. Review and approve the 044 draft, then validate it on a disposable PostgreSQL database as the intended migration owner and verify behavior using the non-superuser `smarterp_app` role. Verify forced RLS and every grant/policy with two synthetic companies before considering registration or application. No migration registration or execution is authorized by this work.
3. Configure and verify the approved `AI_PERSISTENCE_ENABLED`, conversation retention, and document retention settings only after schema review. Current source intentionally returns unavailable until all required settings and readiness checks pass.
4. No retention purge worker is implemented. Retention expiry is enforced by queries/RLS and new records receive retention timestamps; old expired rows require an approved purge process. Conversation deletion is soft deletion; document deletion removes chunks then soft-deletes the parent.
5. Ingestion is synchronous and database-backed; TXT/Markdown only. No PDF/DOCX parser or blob store was added. Privacy, backup, and retention approval for extracted document text is still needed.
6. Semantic/vector search remains disabled pending an approved provider/model and data-handling decision. No vector extension, external embedding call, or model substitution was made.
7. A process crash between persisting a pending user turn and marking the request complete/failed can leave a pending key. Client-close handling marks ordinary disconnects failed, but an operational recovery/reconciliation strategy for abrupt process termination has not been implemented.
8. Citation token validation prevents fabricated source references, but it does not mathematically verify that every natural-language claim is entailed by a cited passage. A valid citation identifies retrieved evidence only.
9. Browser/mobile interaction, two-company RLS behavior, upload persistence, PostgreSQL transaction behavior, actual database grants, and staging/provider behavior remain unverified. Do not describe this candidate as production-ready.

### Worktree preservation

Both repositories remain on `launch-hardening`. Existing backend authorization, AI, invoice, and other uncommitted edits and the frontend invoice-modal change/test remain present. No reset, clean, commit, push, merge, deployment, migration, external provider call, or database connection was performed.

## Enterprise security hardening update — 2026-10-23

This section records the Prompt 2 security review of the current `launch-hardening` source candidates. It supersedes earlier statements in this report that missing company context implicitly enabled RLS bypass, that persistent turns trusted browser history, or that the document policy helper was not used by routes. It does not establish deployment or database readiness.

### Baseline and findings

- Backend and frontend were both on branch `launch-hardening`. Both already contained substantial uncommitted changes before this update. The backend had existing invoice, authorization, subscription, AI, and migration-draft changes; the frontend had the direct-invoice modal/test and Smart AI panel changes. No staged changes were present. No existing work was reset, stashed, or discarded.
- **High, fixed:** `middleware/tenantContext.js` previously inferred `bypassRls` from missing company context. Because `db.js` uses `RESET ROLE` for bypass and otherwise switches to `smarterp_app`, that inference could turn an authenticated identity with missing tenant data into database-owner access. It now preserves bypass only when an explicit server-side outer ALS scope already set `bypassRls: true`; a missing company remains non-bypass and database queries fail closed under the app role. The authenticated `company_id` alias is accepted alongside `companyId`.
- **High, fixed:** Persistent `/api/ai/agent` requests previously could use browser-supplied conversation history. The turn repository now retrieves up to ten preceding messages with conversation, company, and owner predicates. The middleware passes only that stored history to the agent after applying the existing prompt guard; rejected prior turns are excluded. Client history is no longer part of the persistent idempotency fingerprint. Legacy non-persistent chats retain their existing browser-history behavior.
- **Medium, fixed:** Conversation pagination now rejects partial numeric strings and unsafe offsets and caps the supported offset at 1,000,000.
- **Medium, unresolved by design:** A process crash after a turn is inserted as `pending` can leave it pending. Automatic replay/recovery was not added because it could repeat model or ERP tool side effects. Idempotent persistence is not exactly-once execution.
- **Unverified:** The actual `companies.id`/`company_id` type and target database role privileges remain unknown. Repository snapshots conflict across UUID, integer, and text company identifiers. Migration 044 remains an unregistered, unexecuted draft with `company_id TEXT`; that type cannot be approved from source alone.

### Authorization and database context review

- Conversation SQL operations include both `company_id` and `owner_user_id` predicates; document retrieval includes company equality and active/ready/not-deleted/not-superseded conditions in SQL. The document routes call `assertDocumentAction`; document operations are limited to Owner/Admin and the authenticated company. Employee/customer document routes are not exposed through this AI router. `/api/ai/agent` also checks Owner/Admin before document retrieval, and document-only mode does not advertise ERP tools and rejects provider tool calls.
- `db.js` resets role and session settings on each pool checkout, parameterizes `set_config`, and uses `SET ROLE smarterp_app` for non-bypass contexts; role-switch errors abort checkout. These behaviors have mocked unit coverage only. PostgreSQL has not confirmed the role's `BYPASSRLS` attribute, grants, forced RLS, or concurrent pooled-connection isolation.
- Explicit bypass scopes remain in server-owned paths including authentication/customer authentication, account deletion/transfer, webhooks, selected system jobs, and maintenance paths. The change does not remove these established scopes. In particular, `routes/account.js` has router-wide bypass; its exact query and authorization policy deserves a separate route-by-route review. The bypass value is not derived from request company selectors, but the scope's breadth is a residual concern.
- RLS custom settings are set by the application and are defense-in-depth. They do not protect against arbitrary SQL execution under a role that can itself call `set_config`; actual SQL-injection resistance and database role boundaries require isolated PostgreSQL verification.

### Document/RAG review

- TXT/Markdown ingestion is capped at 5 MiB, validates UTF-8, rejects NUL/binary content, hashes the original bytes, bounds chunking, stores version/status metadata, and keeps incomplete processing from being marked ready. Retrieval query filters the current company and only ready, retained, active, non-deleted, non-superseded records before ranking.
- Route handlers enforce Owner/Admin policy for list, upload, search, read, reindex, and delete; document identifiers are UUID-validated, and per-document operations load the document with company-scoped SQL before applying the policy. Soft-deleted or superseded documents are excluded from retrieval. Deletion removes chunks and soft-deletes the document transactionally.
- Retrieved passages are framed as untrusted evidence, document-only mode has no ERP tools, and citation tokens must match chunks retrieved for that request. These controls mitigate injection and citation fabrication; they do not mathematically establish that every generated claim is entailed by its citation.
- Keyword/full-text search only. No embedding provider, vector extension, or semantic search was enabled. PDF/DOCX support was not added.
- Upload buffers and extracted text are stored through the database workflow. No external file storage was introduced. Retention purge worker, privacy/backup policy, and browser upload workflow verification remain outstanding.

### Changes made in this hardening update

- `middleware/tenantContext.js`: removed implicit bypass on missing company; accepted authenticated `company_id` and `userId` aliases.
- `services/aiPersistence.js`: loads server-side prior messages for a validated saved conversation before starting a new request.
- `routes/aiPersistence.routes.js`: sanitizes server-loaded history and excludes rejected historical turns; idempotency fingerprint no longer incorporates browser history.
- `routes/ai.routes.js`: persistent requests consume only the middleware-provided stored history.
- `services/aiConversationPolicy.js`: strict integer pagination parsing and safe offset ceiling.
- `tests/tenantContextSecurity.test.js`: regression tests for no implicit bypass, ignored client tenant selectors, trusted identity alias, and explicit server-side bypass preservation.
- `tests/aiPersistence.test.js`: tests server-side history query scoping and that forged browser history does not affect persistent history/fingerprint; response-size guard remains covered.
- `tests/aiConversationPolicy.test.js`: malformed and oversized pagination cases.
- `tests/employee_onboarding_linking.test.js`: the DB-oriented test now supplies the same explicit trusted bypass scope used by the auth router instead of depending on missing-company inference.

No migration file, migration runner, frontend module, invoice implementation, subscription configuration, or account policy was changed for this security update. The pre-existing invoice and other candidate diffs remain in place.

### Verification performed

- Backend, from `SmartERP-BackendEnd`, with `REDIS_URL` cleared:
  - `node --check middleware/tenantContext.js` — passed.
  - `node --check routes/aiPersistence.routes.js` — passed.
  - `node --check services/aiPersistence.js` — passed.
  - `node --check routes/ai.routes.js` — passed.
  - `node --test tests/tenantContextSecurity.test.js tests/rlsContextPropagation.test.js tests/aiPersistence.test.js tests/aiDocumentPipeline.test.js tests/aiConversationPolicy.test.js tests/aiFastPathPolicy.test.js tests/aiFastPathRouteAuthorization.test.js tests/aiToolEntitlements.test.js tests/aiAssignedJobs.test.js tests/aiAttendanceSummaryAccess.test.js tests/planMiddlewareFallback.test.js tests/phase5FinanceSecurity.test.js` — **82 passed, 0 failed, 0 skipped**. Includes mocked/unit/source-contract coverage; some fixtures intentionally log simulated errors. No database connection was used by this command.
  - `git diff --check` — passed.
- Frontend, from `SmartERP-Frontend`:
  - `npx tsc --noEmit` — passed.
  - `node --test tests/direct-invoice-modal-responsive.test.mjs` — **12 passed, 0 failed**. This is a source/build-engine test, not browser visual verification.
  - `npm run build` — passed. Existing React hook dependency and `<img>` optimization lint warnings were emitted in unrelated pages/components.
  - `git diff --check` — passed.
- No PostgreSQL, migration parser, disposable database, browser, staging API, production database, model provider, embedding service, payment provider, or production system was accessed. No migration was registered or executed, and no deployment/commit/push/merge occurred.

### Remaining Prompt 3 / release gates

1. Confirm actual schema and `company_id` type in a disposable database; validate migration 044 there, including constraints, indexes, forced RLS, policy behavior, grants, and rollback.
2. Verify `smarterp_app` is non-superuser and lacks `BYPASSRLS`; test tenant isolation with two companies and two users in one company, as well as pooled concurrent contexts, using real PostgreSQL.
3. Resolve and review the breadth of explicit bypass scopes, especially router-wide account and webhook scopes, without weakening onboarding or system jobs.
4. Define safe operational handling for stale pending turns; do not replay side-effecting model/tool requests automatically.
5. Decide and implement retention purge/deletion policy, and approve storage/privacy/backup handling for extracted documents.
6. Run browser/mobile tests for saved conversations, upload, search, citation display, owner/admin restrictions, and fallback/error states; run controlled staging verification with a production-host-blocking harness.
7. Keep semantic search disabled until provider/model/data-handling approval. Keep document support to TXT/Markdown until parser dependencies are selected and tested.

**Status:** source-level and mocked security hardening passed the listed checks. The candidate is **not production-ready**: database/schema/RLS/grant verification, migration 044 validation, browser verification, and staging checks remain blocked/unverified.

## Prompt 3 — Production Readiness and Release Gates — 2026-10-23

This update records the current `launch-hardening` candidate after source review and safe local checks. It supersedes the earlier Prompt 2 note that `routes/account.js` had router-wide bypass. No production database, provider, or environment secret was accessed. Migration 044 remains a draft, unregistered and unexecuted.

### Repository state

- Both repositories are on branch `launch-hardening`; no staged changes were present. The backend already contained the earlier AI, invoice, subscription, and authorization working-tree changes plus untracked AI persistence/RAG files and tests. The frontend already contained the direct-invoice modal and Smart AI panel changes plus the invoice modal test. This report and the tests/source named below are part of that existing candidate. No existing work was reset, stashed, or discarded.
- Prompt 3 source changes: `routes/account.js`, `routes/webhook.js`, new `services/accountOwnershipTransfer.js`, `utils/asyncLimiter.js`, new `ai/plugins/toolArguments.js`, `ai/plugins/index.js`, `ai/planner/ReAct.engine.js`, and tests `accountOwnershipTransferSecurity.test.js`, `aiToolArguments.test.js`, `groq_concurrency.test.js`, and `ai_subscription_rbac.test.js`.
- `ai_subscription_rbac.test.js` contained stale plan/tool names (`free`, `basic`, `pro`, and payroll function names no longer registered). Its assertions were updated to the source's canonical Starter/Professional/Enterprise tiers and current registered tool names while retaining plan-boundary and employee-denial assertions. The implementation's plan behavior was not changed to satisfy the old test.

### Implemented source fixes

- **Account transfer bypass narrowed:** removed the router-wide RLS bypass from `routes/account.js`. Only the ownership-transfer service enters a scoped bypass. It checks that the authenticated caller is still an active company owner in the database, verifies the password, scopes both user records and role updates to the authenticated company, performs the changes in a transaction, and rolls back if the company ownership update affects zero or multiple rows. This preserves the legacy `companies.id`/`companies.company_id` lookup form but fails closed if it is ambiguous. Mock tests cover stale owner role, cross-company target, rollback, and ambiguous company matching. This does not independently prove the deployed database's key layout.
- **Webhook bypass narrowed:** `routes/webhook.js` now grants the bypass only to `/razorpay`, rather than every route on that router. The handler verifies the provider HMAC before its business processing. Provider delivery and database effects were not exercised.
- **Provider tool arguments bounded:** `ai/plugins/toolArguments.js` limits serialized arguments to 16 KiB, strings to 8,000 characters, arrays to 100 entries, nesting to 8 levels, and total nodes to 256; rejects prototype-sensitive keys; and validates declared schema types, required properties, enums, bounds, and `additionalProperties:false` where declared. `PluginRegistry.execute` runs this validation after entitlement/RBAC checks. The ReAct loop rejects oversized tool JSON and more than 8 tool calls in a completion before invoking tools.
- **Provider queue bounded:** Groq SDK timeout is 10 seconds with retries disabled (`ai/providers/groq.provider.js:71-72`). The per-process limiter now caps configured concurrency at 20, pending queue at 10,000 (default 100), and queue wait at 120 seconds (default 15 seconds), returning safe 503 codes on saturation/queue timeout. The limiter is process-local; deployment-wide concurrency depends on worker and instance count and has not been measured.

### Privileged database contexts reviewed

- **Narrowed in this update:** owner transfer at `services/accountOwnershipTransfer.js:16`; signed Razorpay callback at `routes/webhook.js:14-15`.
- **Still broad and unresolved:** staff authentication router uses bypass for every route at `routes/auth.js:31`; customer-authentication router does likewise at `routes/customer/auth.js:36`. Their pre-auth login/OAuth/OTP/company-code lookups require cross-company identity discovery, but router-wide scope also covers routes after authentication. Splitting these requires an endpoint-by-endpoint query/context audit and was not guessed here.
- **Account deletion:** four explicit service scopes at `services/accountDeletionService.js:71,173,345,396`. They identify the authenticated account/customer, reauthenticate or consume a deletion challenge, and include transactional erasure paths. The operations are destructive and still need a route-to-service authorization and transaction review; no real deletion was invoked.
- **System-owned operations:** daily attendance processor at `jobs/dailyAttendanceProcessor.js:38`; biometric attendance callback at `routes/attendance.js:1050`; authenticated location write at `routes/location.js:84`; startup database initialization in the production master at `server.js:1022-1026`; and health check `SELECT NOW()` at `server.js:191`. These are trusted server paths, but their exact operational scopes and existing startup DDL are not equivalent to a general request context. The startup DDL remains a separate release/migration risk.
- Account deletion/transfer, webhook, authentication, scheduler, biometric, and startup scopes were source-inspected; no claim is made that all scopes have PostgreSQL/RLS test coverage. `db.js` still has the intended structural split: non-bypass requests `SET ROLE smarterp_app`; explicit bypass resets to the connection role. Actual attributes of that database role remain unverified.

### Migration 044 / database gate

- Static draft contract: `public.users.id` must be `UUID NOT NULL`; `smarterp_app` must exist and must not be superuser or have `BYPASSRLS`; four additive tables are expected; `company_id` is stored as `TEXT`; forced RLS policies use `app.current_company_id`, `app.current_user_id`, and `app.current_role`; indexes cover company/user history, request keys, and full-text search; app grants are limited to operations needed by current repositories. The draft contains compatibility checks and transactional DDL, but those properties have not been confirmed by a PostgreSQL parser or database execution.
- The repository's context parser permits integer-like or UUID-like company IDs (`db.js`), while candidate source/schema snapshots disagree about the actual production `companies.id` / `company_id` types. The draft avoids a company FK and stores text; this is not proof the runtime comparisons, foreign keys to `users`, role names, or RLS policy behavior match the intended database.
- No explicitly verified disposable PostgreSQL instance, isolated database identity marker, or test-only credentials were available in this run. Consequently, none of the required two-company/two-user RLS tests, role-attribute/grant checks, transaction/rollback tests, connection-pool isolation tests, migration repeat/rollback checks, or migration syntax validation was run. **No live database state is asserted.**
- Exact operator preflight before any future test: create a disposable PostgreSQL instance/database from an approved schema-only baseline; create a separate non-superuser runtime role with `NOBYPASSRLS`; use test-only credentials; confirm the connection target/database/identity marker using `SELECT current_database(), current_user, inet_server_addr()` and role attributes; ensure it contains no business data; then test a reviewed copy of 044 and its rollback using synthetic Company A/B and two users. Do not point those steps at a hosted production project. Migration registration/execution requires separate approval.

### Persistence, retention, and recovery findings

- Retention days are required configuration (`AI_CONVERSATION_RETENTION_DAYS`, `AI_DOCUMENT_RETENTION_DAYS`, each 1–3650) before persistence is enabled; this run did not inspect `.env` files or credentials. Repository queries hide expired records, and new records receive retention timestamps. There is **no bounded retention purge worker**. Conversation deletion is soft deletion; document deletion removes chunks and soft-deletes the parent. This does not erase backups, logs, database snapshots, or prior exports.
- A process crash after creating a `pending` turn can leave the idempotency key pending indefinitely. The normal request path can mark failure, but no stale-pending reconciler exists. Automatic replay remains unsafe because an ERP tool may already have executed.
- Document ingestion is synchronous, TXT/Markdown only, capped at 5 MiB per upload; parser libraries, object storage, and embedding providers were not added. Database query `statement_timeout` is configured at 15 seconds (`db-base.js:66`), but large text ingestion creates multiple chunk inserts synchronously and no load benchmark was run. No purge scheduling, backup restore, or deletion-from-backups procedure is verified.
- Deletion semantics, retention period, legal hold, extracted-text backup/privacy handling, and whether soft deletion should eventually become physical deletion require owner/privacy approval before purge implementation.

### AI tools, web, and operational verification

- Gateway routes require authentication, loaded plan, AI feature access, and prompt validation (`routes/ai.routes.js:65-72`). The plugin registry independently checks plan entitlement, specialist model scope, required user/company identity for protected plugins, and role guards for payroll/finance/GST. Tool schemas are validated at execution. Existing tests exercise attendance, low-stock inventory, jobs, payroll/finance/GST roles, prompt injection, safe errors, and tenant-scoped resolvers.
- This is not proof that every live ERP plugin query is tenant-scoped: there is no exhaustive per-tool PostgreSQL authorization matrix. The confirmation endpoint is authenticated/plan-gated and plugin execution rechecks entitlements and role authorization, but it accepts the tool and parameters from the client and has no one-time server-issued confirmation challenge. The explicit endpoint serves as the current confirmation boundary; replay/idempotency semantics for every destructive tool are not uniform and remain a security review item. No destructive tool was called.
- General API throttling is 300 requests/15 minutes per IP (`server.js:224+`), not per authenticated user or AI spend. Provider queue bounds and tool-call/argument limits exist, but deployment-wide provider pressure, tenant fairness, cost ceilings, cancellations, and alert thresholds are unmeasured. `express.json` is configured at 50 MiB (`server.js:254+`); the AI prompt guard has narrower prompt/history checks, but there is no separate AI-specific request-body limit/rate bucket verified here.
- No compatible browser automation framework/test suite is configured for Smart AI workflows, and no safe local backend/database harness was started because backend initialization may run database setup. Thus saved conversations, uploads, citations, fallback behavior, keyboard/screen-reader usability, mobile layouts, multi-tab behavior, auth expiry, network failures, and real UI/backend persistence are **not browser-verified**. A frontend build/type check is not visual verification.

### Checks actually run

- Backend focused security/AI suite with `REDIS_URL` cleared: 15-file command covering account transfer, argument validation, limiter concurrency, tenant/RLS context, persistence, document pipeline, policy/fast-path, tool entitlement, jobs, attendance, plan fallback, and Phase 5 finance — **92 passed, 0 failed**.
- Additional backend AI suite with `REDIS_URL` cleared: `node --test tests/ai_subscription_rbac.test.js tests/aiDataServiceTenantScope.test.js tests/aiLowStockInventory.test.js tests/aiReliability.test.js tests/aiPromptGuard.test.js tests/aiProviderAvailability.test.js tests/aiQuota.test.js` — **35 passed, 0 failed**. On the first run, the pre-existing `ai_subscription_rbac.test.js` failed 3 assertions because it used obsolete plan labels and non-existent tool names; after aligning only the fixtures/assertions with the current catalog and registered tools, the same test selection passed. This was mocked/unit/source testing, not a database test.
- Backend syntax: `node --check routes/account.js routes/webhook.js services/accountOwnershipTransfer.js ai/plugins/toolArguments.js ai/plugins/index.js ai/planner/ReAct.engine.js` (run as individual `node --check` commands) — passed.
- Frontend: `npx tsc --noEmit` — passed; `npm run lint` — exit 0 with existing hook-dependency and `<img>` warnings; `npm run build` — passed, with those lint warnings; the seven available `*.test.mjs` files — **40 passed**; the six available `*.test.js` files — **30 passed**. These frontend tests are Node/source-level tests, not browser interactions.
- `git diff --check` passed in both repositories. One initial syntax-check invocation used frontend as its working directory while referencing backend paths, and correctly failed with “module not found”; the backend syntax checks above were then run from the backend directory and passed. No source was changed by the incorrect invocation.

### Remaining release blockers and decision

1. **BLOCKED:** Verify schema contract and execute migration 044/RLS tests on an approved disposable PostgreSQL database as migration owner and `smarterp_app`; verify no `SUPERUSER`/`BYPASSRLS`, grants, forced policies, constraints, indexes, concurrent pooled identity, rollback, and two-company/two-user isolation. Migration 044 remains unregistered and unapplied.
2. **HIGH:** Narrow authentication and customer-authentication router-wide bypass with endpoint-level review, and complete the destructive account-deletion/bypass review without weakening onboarding or required lookups.
3. **HIGH:** Approve and implement retention purge/deletion and stale-pending reconciliation policy. Do not auto-replay uncertain ERP side effects.
4. **HIGH:** Complete per-tool SQL/tenant/RBAC/entitlement verification and decide if destructive actions need one-time server-side confirmation tokens and idempotency.
5. **BLOCKED:** Run actual browser tests and responsive/accessibility checks against an isolated backend and database, then controlled staging with production-host blocking. No staging provider/data path was verified.
6. **UNVERIFIED:** Measure provider/database throughput, per-tenant fairness/cost ceilings, worker-wide concurrency, upload ingestion latency/memory, monitoring/alerts, backup restore, and deletion from retained backup copies.
7. Keep semantic/vector search disabled and TXT/Markdown-only ingestion until their separate provider/parser and data handling decisions are approv
**Release status: NOT READY.** Source-level changes and mocked tests pass, but critical database/RLS, browser/staging, retention/recovery, and remaining privileged-scope checks are not verified. No production readiness is claimed.

### Continued source remediation — authentication RLS scope

- Replaced router-wide RLS bypass in `routes/auth.js` and `routes/customer/auth.js` with method-and-path allowlists in `middleware/authRouteRlsScope.js`. Non-allowlisted routes begin with `bypassRls: false`; the authenticated staff routes therefore rely on `authenticateToken` and its trusted tenant context rather than inheriting a router-wide bypass.
- The staff allowlist covers pre-auth identity lookup endpoints (login, OTP/password recovery, OAuth, token refresh/logout, signup, email/company lookup) and the explicit temporary-token `/employee/onboarding` company-linking flow. The customer list is restricted to public identity/bootstrap endpoints. Unknown paths and wrong HTTP methods do not get cross-tenant context.
- Removed the additional explicit bypass from authenticated `GET /me`; its query is by authenticated user ID under the tenant context established by `authenticateToken`.
- Added `tests/authRouteRlsScope.test.js` for path/method matching, trailing-slash normalization, authenticated route denial, the onboarding exception, and customer route scope.
- **Verification:** `node --check middleware/authRouteRlsScope.js`, `node --check routes/auth.js`, and `node --check routes/customer/auth.js` passed; `node --test tests/authRouteRlsScope.test.js` — 5 passed, 0 failed; `git diff --check` passed.
- **Safety correction:** an attempted broader auth test command included `tests/account_deletion.test.js`. Source inspection afterward confirmed this test directly runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, creates `account_deletion_audit`, and then inserts synthetic company/user/customer records using a `TEST-<time-suffix>-1` company code. It emitted `Migration ensure notice: must be owner of table users`; because that DDL error is caught by the test, execution can continue to its inserts. The process was stopped, but whether any later inserts committed is **unknown**. The configured database target was not identified, and this attempt may have reached a non-disposable database. No further database access or cleanup was attempted. **Please inspect the database through your approved operator process for test artifacts before any further tests; do not rerun this suite until an explicitly disposable database is isolated.** This command is not counted as a passed test or safe verification. It did not intentionally run migration 044.
- This source-level allowlist does not replace PostgreSQL verification. In particular, verify route-by-route behavior for OAuth callbacks, refresh/logout, and temporary employee onboarding under the supported schema and RLS policies. Existing account-deletion service bypass scopes remain explicit and unverified pending a dedicated isolated database test.

**Updated release status: NOT READY.** This source change narrows the cross-tenant context inherited by authenticated auth routes, but production release is still blocked by migration 044/database/RLS verification, retention and stale-turn policy, exhaustive tool/RBAC verification, browser/staging testing, and recovery/operations checks listed above.

### Canonical migration file preparation — 2026-10-23

- Promoted the AI schema from the proposal copy to `migrations/044_ai_rag_persistent_conversations.sql`. The file remains additive and transactional; the proposal copy is explicitly marked superseded to avoid directing operators to a duplicate.
- Registered migration 044 after migration 043 in `migrations/forwardMigrationRunner.js` and classified it as controlled-only, excluded from startup migration execution. This makes its identity/checksum available to the reviewed controlled migration mechanism without applying it.
- Added postcondition verification for all four tables, forced RLS, the ten expected indexes, four named policies, safe `smarterp_app` role attributes, minimum effective grants, no app TRUNCATE, and no browser-role access. The SQL revokes any direct preexisting grants on these new tables before granting the intended app permissions.
- Added mocked/source tests in `tests/aiPersistenceMigration.test.js` and extended `tests/migrationRunnerRegressions.test.js` to cover migration order, startup exclusion, least-privilege checks, and failure on unsafe postconditions.
- **Verification:** `node --check migrations/forwardMigrationRunner.js`; `node --test tests/aiPersistenceMigration.test.js tests/migrationRunnerRegressions.test.js` — 11 passed, 0 failed; `git diff --check` passed. These tests do not parse or execute SQL in PostgreSQL.
- `psql`, `postgres`, `initdb`, `pg_ctl`, and Docker are unavailable in this environment. No local PostgreSQL validation, live Supabase inspection, migration execution, or runner execution occurred. The exact `company_id` compatibility, `smarterp_app` role attributes/effective inherited privileges, policy behavior, and SQL catalog checks remain unverified. Having a backup does not replace those compatibility checks.
- The only AI-feature migration candidate is `044_ai_rag_persistent_conversations.sql`. **Do not run it in Supabase yet**: it must first pass a PostgreSQL parser/disposable-database run and live-schema preflight. No other existing migration should be run solely for the AI feature; migrations 039/040/041 must not be rerun based only on absent migration history.

**Current status: migration prepared and controlled-registered; NOT validated or applied. Release remains NOT READY.**
