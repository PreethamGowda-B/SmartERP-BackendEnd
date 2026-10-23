# SmartERP AI — Phase 0 Read-Only Repository Audit

**Audit date:** 23 October 2026
**Evidence:** current local source on branch launch-hardening, manifests/lockfiles, migration files, and one bounded mocked/unit test run.
**Scope:** SmartERP-Frontend, SmartERP-BackendEnd, and customer-app-like folders in the workspace.
**Not established:** deployed revision, production database schema/RLS, production provider health, live email/payment behavior, or browser/runtime behavior.

## 1. Executive summary

SmartERP has an authenticated shared AI assistant for internal portals, a deterministic live-data fast-path layer, a bounded tool-calling loop, a Groq adapter, and a registry that filters tools by role, plan, and specialist scope. Current source includes prompt sanitization and a separate Super Admin security-investigation workflow. The frontend keeps chat conversations in user-keyed browser localStorage; there is no server-side AI conversation store in the active paths inspected. A static string-matching RAG class exists but is not connected to the request path. The Customer web portal has no mounted AI chat; a customer-summary backend tool exists but does not establish a shipped customer assistant.

Two significant source-level authorization concerns need focused review before broad rollout: the deterministic route fast paths occur before specialist model-scope enforcement, and the separately mounted business-copilot job-creation endpoint accepts an authenticated request with a boolean confirmation but no explicit creator-role allowlist or replay key in the inspected route. These findings are source-confirmed; exploitability in a deployed environment is not established here.

AI audit telemetry remains inconsistent with migration 018 and still attempts CREATE/ALTER TABLE during telemetry reads and writes. The recent hardening commit does not remove this AI telemetry DDL. AI-specific table grants and effective RLS are not verified. Current unit tests run safely for entitlement logic and prompt guarding: 13 passed. No database, external provider, browser, or production connection was used.

**Recommendation:** Do not begin the broad AI platform rewrite. Review the two authorization findings and the business policy decisions below; then implement the smallest, testable authorization correction first, followed by audit-schema reconciliation and controlled integration verification.

## 2. Repository and working-tree baseline

| Path | Git status | Current revision | Stack / lockfile facts |
|---|---|---|---|
| SmartERP-Frontend | Git repository; branch launch-hardening; tracked working tree clean. | ff8962506757fe109aaf46968c256fa84b037d03. The branch contains origin/main (8cd3d2a) and newer hardening commit ff89625. | Next.js manifest ^14.2.16, React ^18.3.1; lock resolves Next 14.2.35, React/React DOM 18.3.1, TypeScript 5.9.3. Node/npm project. |
| SmartERP-BackendEnd | Git repository; branch launch-hardening; one untracked file: docs/SMARTERP_AI_ARCHITECTURE_DECISION_RECORD_AND_IMPLEMENTATION_ROADMAP.md. No tracked modifications observed. | f2e6c21eac42f1e22652238a2ba41dbe06f18143. The branch contains origin/main (442e4c5) and newer hardening commit f2e6c21. | Node/Express manifest: Express ^4.18.2, pg ^8.11.0, groq-sdk ^0.7.0; lock resolves Express 4.22.1, pg 8.18.0, groq-sdk 0.7.0, BullMQ 5.71.0, ioredis 5.10.0. |
| SmartERP-Customer App | Directory exists, but no .git directory; it is not an identifiable Git repository. Appears to be a native Android/Kotlin app from Gradle files. | No branch or commit can be established. local.properties exists; its contents were not read. | Top-level Gradle declares Android plugin 8.2.2, Kotlin Android 1.9.22, Google Services 4.4.1. Runtime dependency versions were not fully inventoried. |
| SmartERP workspace/root | Container folder, not a Git repository. Contains a nested SmartERP-BackendEnd directory. | N/A | No independent application baseline established. |

Neither primary Git worktree was changed. The architecture roadmap file was already present as an untracked backend document at audit start and was preserved. Environment files and local.properties contents were not read. Configuration names are listed only where needed; presence/value of runtime secrets is unknown.

The current branches include their local main/origin/main ancestors without checking out or changing branches. This proves source ancestry only, not that the current revisions were pushed, deployed, or running.

### Differences from the current-state discovery document

- The discovery document describes the inspected source as including uncommitted changes. Current status shows the two application worktrees have no tracked modifications; only the untracked roadmap document is present in backend.
- The current backend hardening commit is newer than the discovery snapshot. It changes other runtime schema/startup behavior, but ai/telemetry/metrics.service.js still contains request-path CREATE TABLE and ALTER TABLE calls. The AI-specific DDL concern remains source-confirmed.
- The discovery's broad architecture conclusions remain consistent: the active provider factory selects Groq only; customer chat is not mounted; browser history is localStorage; the RAG helper is disconnected; plan-scope and deterministic fast-path enforcement are separate.
- No source or Git evidence reviewed here establishes production deployment, active database objects, effective grants/RLS, or third-party service status.

## 3. Existing AI architecture and request-flow map

```text
Next app/layout.tsx
  -> FloatingActionHub
  -> SmartAIPanel (internal authenticated portals; Customer path explicitly hidden)
  -> shared apiClient POST /api/ai/agent
  -> Express v1Router mounted at both /api/v1 and /api
  -> routes/ai.routes.js POST /agent
  -> authenticateToken -> loadPlan -> requireFeature(ai_assistant) -> prompt/history/context guard
  -> deterministic greetings / ERP data fast paths
  -> plan specialist-scope resolution
  -> ReActEngine -> PluginRegistry tool allowlist -> tool handler / existing ERP service
  -> GroqProvider -> response formatting -> best-effort AI telemetry and action audit

Separate paths:
  POST /api/ai/confirm-action -> authenticated/plan-gated plugin execution
  POST /api/ai/chat -> legacy compatibility endpoint using ReActEngine
  /api/ai/copilot -> separate keyword workflow and direct job-create path
  /api/ai/copilot/activity -> Owner CNC AI activity list
  /api/ai/stats, /api/ai/audit-logs -> Super Admin/Owner audit surfaces
  /api/v1/superadmin/security and /api/superadmin/security -> separate Super Admin security analysis
```

### Request paths and reachability

| Path | Evidence and reachability |
|---|---|
| Shared UI | app/layout.tsx mounts FloatingActionHub at the shared authenticated application shell. components/floating-action-hub.tsx renders SmartAIPanel. components/smart-ai-panel.tsx checks user/plan access and returns null on /customer routes. This is the verified main UI mount; route-level availability remains runtime-unverified. |
| Main agent API | server.js mounts routes/ai.routes.js under /api/v1/ai and also mounts the same v1Router at /api. POST /agent therefore has /api/v1/ai/agent and /api/ai/agent compatibility paths. routes/ai.routes.js applies authenticateToken, loadPlan, requireFeature(ai_assistant), and validateAiPrompt. |
| Deterministic data | routes/ai.routes.js handles greetings, attendance, employee-assigned jobs, job counts, payroll/HR, inventory and finance before resolveAiModelScopes. Relevant data comes from AIDataService and the attendance helper. |
| Specialist model routing | After fast paths, routes/ai.routes.js calls resolveAiModelScopes and passes the resulting scopes to ReActEngine. Multiple selected scopes use Promise.all over the same ReActEngine/provider stack; this is parallel logical scopes, not independent autonomous services. |
| Tool registration and execution | ai/planner/ReAct.engine.js gets available tools from ai/plugins/index.js, invokes pluginRegistry.execute, and iterates up to three times. Registry filters tools by scope, plan and allowedRoles; execution rechecks scope/plan and role guards. Tool handlers often call existing services with company context. |
| Provider | ai/providers/provider.factory.js returns GroqProvider for the configured provider name and also defaults to Groq. ai/providers/groq.provider.js uses groq-sdk; lock resolves 0.7.0. Constructor reads GROQ_API_KEY and GROQ_MODEL. No second adapter is selected by the factory. Timeout and retry settings are source-coded in the adapter; live provider configuration/availability is unknown. |
| Confirmation | ReActEngine can return server-derived confirmation metadata; POST /api/ai/confirm-action reauthenticates, reloads the plan, validates parameters, rebuilds context and executes through the registry. General idempotency/replay behavior is not established for all mutation tools. |
| Business Copilot | routes/businessCopilot.js is mounted under /api/v1/ai/copilot and /api/ai/copilot. The activity API is called by app/owner/cnc/ai-activity/page.tsx. AiCopilotDrawer calls the POST workflow, but no mount/render site for the drawer was found in the frontend search; direct API reachability is verified by server mount. |
| Super Admin | /api/ai/stats only permits role super_admin. /api/ai/audit-logs permits owner or super_admin and clamps Owner queries to req.user.company_id. Security analysis is a separate routes/security.js path and worker. These are distinct from the standard company assistant. |
| Customer | SmartERP-Frontend has Customer routes and a separate customerApi client, but no SmartAIPanel/FloatingActionHub/AI endpoint caller under app/customer or components/customer. LiveSummaryPlugin registers get_customer_summary for role customer and calls AIDataService.getCustomerDashboardSummary with authenticated user id, email and company. Backend capability does not mean Customer chat is mounted. The separate Android directory is not a Git repo and is not established as the web customer portal. |
| Conversation history | SmartAIPanel reads/writes user-keyed conversations in browser localStorage. No active AI conversation/message persistence route or AI conversation schema was found. Existing generic messaging conversations are not AI chat persistence. |
| RAG/documents | ai/rag/rag.service.js contains hard-coded policy snippets and string matching; no active import/call was found in the AI path. services/ai.service.js is another direct Groq wrapper with a hard-coded model and broad prompt, but no active caller was found. Employee/customer document modules are separate; no AI ingestion/index/ACL-aware retrieval pipeline was found. |

## 4. Verified capability versus target architecture

| Capability | Current source status | Target ADR status |
|---|---|---|
| Central AI gateway and authenticated company context | Implemented in source; deployed/runtime behavior unverified. | Foundation present, needs consistency/evidence. |
| Live ERP read tools | Implemented for selected domains; many use company predicates and role gates. Coverage and each query policy require tool-by-tool tests. | Continue using existing services; current-state freshness tests required. |
| Logical specialists | Implemented as scopes/plugin filters over shared orchestration/provider. | Compatible with ADR-002; not independent agents. |
| Specialist entitlement | Backend resolver exists after deterministic fast paths; UI also locks models. | Incomplete until direct API/fast-path coverage is made consistent with approved policy. |
| Provider-neutral multi-provider gateway | Factory/interface pattern exists, but factory only returns Groq. | Planned; no provider failover beyond Groq candidate-model behavior is equivalent to a second provider. |
| Prompt injection controls | Pattern-based sanitizer/guard and security event path exist in source; bounded tests pass. | Partial security control; not proof of detection against all adversarial prompts. |
| Server-side conversations | Not found; browser localStorage is used. | Planned; lifecycle and privacy decisions required. |
| Document RAG/connected storage | No active RAG or ingestion path found. Static placeholder class only. | Planned; connector/search/ACL decisions required. |
| Customer assistant | No mounted chat UI; customer summary plugin exists. | Planned after customer identity and data policy approval. |
| Action lifecycle | Main action confirmation path exists; separate business-copilot workflow remains. | Incomplete until all mutation paths converge on reauthorization/idempotency/audit lifecycle. |
| Audit/telemetry | Runtime telemetry service and tables/migrations exist, but schema mismatch and request-time DDL remain in source; actual persistence/RLS unknown. | Incomplete and release-gated. |

## 5. Security and authorization findings

### P1 / High — deterministic fast paths precede specialist entitlement checks

- **Evidence:** routes/ai.routes.js applies authentication and the ai_assistant feature guard, then executes deterministic attendance/jobs/payroll/inventory/finance branches around lines 91–340. resolveAiModelScopes is called later around lines 420–437, only on the model path. services/aiMetricAccess.js checks roles but receives no plan; services/aiModelEntitlements.js defines Starter/Professional/Enterprise specialist scopes.
- **Verified status:** Source-verified ordering and role-only helper; no production exploitability claim. Current entitlement unit tests cover resolveAiModelScopes but do not prove each fast path is blocked or allowed by the same policy.
- **Potential impact:** A user may obtain a specialist-category deterministic summary even where the corresponding selected model scope is not entitled, depending on the approved product policy. Role checks still apply to guarded branches and the route still requires ai_assistant.
- **Recommendation:** Product owner must decide whether a fast path is included in the plan's allowed specialist capability. Then enforce one shared entitlement policy before each data resolver or explicitly document why that data path is separate from model access.
- **Acceptance:** Direct API tests for each role/plan/path demonstrate allowed response and forbidden 403/entitlement result before any data-service call; test call count is zero on denial.

### P1 / High — business copilot job mutation lacks an explicit creator-role allowlist and retry idempotency

- **Evidence:** server.js mounts businessCopilot under both compatibility namespaces. routes/businessCopilot.js POST route applies authentication, plan loading, AI feature and a prompt guard; job quota is checked for creation prompts. In its job-creation branch, a false confirm_action returns a proposal and true inserts into jobs, then attempts an AI timeline event whose failure is ignored. There is no explicit owner/admin role gate in that creation branch and no idempotency key/unique request record in the inspected code. A separate high-risk branch does check owner/admin, but this is not the same as job creation.
- **Reachability:** Direct route mount is source-verified. AiCopilotDrawer calls the POST route, but a UI mount was not found. UI uncertainty does not remove the direct API route.
- **Potential impact:** Authenticated roles that pass the plan/feature/quota middleware may be able to create the canned job workflow when confirm_action is true; retries may create duplicates. This is a source-level authorization/idempotency gap, not a confirmed production incident.
- **Recommendation:** Decide the allowed roles and whether this legacy endpoint is retained. Prefer route retirement or routing through the canonical action confirmation/execution path. Add execution-time role/tenant/quota validation and idempotency if retained.
- **Acceptance:** Direct route integration tests show unauthorized roles get 403 with no job insert; authorized user confirmation persists once; replay returns the same result and does not add another job; audit failure behavior is explicit.

### P1 / High — customer entry point absent; customer tool policy needs direct endpoint proof

- **Evidence:** SmartAIPanel explicitly hides /customer paths; no AI UI/API caller was found under customer frontend code. LiveSummaryPlugin exposes get_customer_summary to role customer using authenticated id/email/company. The general agent route itself accepts authenticateToken plus company plan feature checks.
- **Verified status:** UI absence and backend tool registration are source-verified. Whether customer tokens can reach the general AI route and whether all customer identity mappings are correct is unverified at runtime.
- **Potential impact:** The UI and backend capability are inconsistent. If intentionally enabled later, mistakes in mapping customer identity to ERP customer records could expose another customer's records.
- **Recommendation:** Keep the route unavailable until the product owner approves customer assistant scope; test customer authentication, company mapping, customer_id mapping, record ownership, and cross-customer access directly. Consider separate route/tool allowlists for customer requests.
- **Acceptance:** Customer A can only retrieve Customer A's authorized jobs/invoices/documents within the correct tenant; Customer B and staff-only data are inaccessible; unapproved roles cannot invoke customer-only tools.

### P2 / Medium — AI audit schema mismatch and request-time DDL

- **Evidence:** migrations/018_ai_copilot_and_audit_logs.sql defines ai_audit_logs with SERIAL id, user_name, role, company_id INT, prompt, action_name, affected_record_id, status, details, created_at. ai/telemetry/metrics.service.js ensureTable creates a different table shape (UUID id, company_id TEXT, user_role, tool_name, action_params, status, error_message, created_at), then performs request-path ALTER TABLE for extensions and swallows ALTER errors. The service is called on primary request success/failure, stats and audit-log paths.
- **Potential impact:** Existing table created from migration 018 is not made compatible by CREATE TABLE IF NOT EXISTS. Runtime writes or Super Admin metrics queries may fail or be partially unavailable; audit failures are best-effort in several call sites. Effective deployed state is unknown.
- **Recommendation:** Inventory supported installed schemas, define one canonical schema and compatibility strategy, then use a reviewed additive migration. Remove DDL from request execution only after compatible schema is deployed and verified.
- **Acceptance:** Disposable PostgreSQL upgrade tests from each supported baseline; audit insert/read/stats work with application role; failure is observable; no request path executes CREATE/ALTER.

### P2 / Medium — AI action audit not proven append-only or tenant-isolated at database layer

- **Evidence:** migrations/022_cnc_phase3.sql creates ai_action_audit_trail and indexes. That migration does not show ENABLE/FORCE ROW LEVEL SECURITY or policies for that table. Source app queries filter company_id in the business copilot activity path. Database effective RLS/grants are not inspected.
- **Potential impact:** Application query predicates are important but a database-side policy may be absent. No database exposure is claimed without live role/policy evidence.
- **Recommendation:** Verify actual role grants and RLS on a confirmed disposable/approved read-only database; design tenant policies and append-only permissions through reviewed migration if absent.
- **Acceptance:** Effective application-role tests across two tenants deny cross-company reads and mutation/deletion of audit rows.

### P2 / Medium — Company-wide aggregates visible to employee-facing AI need product policy

- **Evidence:** AIDataService.getCompanyJobStatusCounts and company attendance summary are company-wide; route fast paths and AttendancePolicy allow roles including employee for some summaries. Separate employee assigned-job helper correctly scopes to user and company. Existing docs flag this as unresolved.
- **Potential impact:** Employees may receive workforce/company aggregates beyond the intended role. This is a policy ambiguity, not a confirmed policy violation.
- **Recommendation:** Owner/security approve per-metric visibility; add role-specific queries and direct API tests, retaining personal assignment behavior.
- **Acceptance:** Employee receives only approved aggregate/personal data; disallowed payroll/finance/personnel detail denied before SQL execution.

### P2 / Medium — Action confirmation/retry semantics vary across tools

- **Evidence:** Main confirm-action rebuilds trusted context and executes via PluginRegistry, but no general idempotency contract is visible at the endpoint. Legacy business-copilot has a separate confirm_action flag and direct SQL job creation. Timeline audit writes in that workflow can fail silently.
- **Potential impact:** Repeated confirmed action requests may repeat mutations; audit history may not explain all outcomes.
- **Recommendation:** Establish canonical action ID, actor/tenant-bound proposal, expiry, one-time execution state, transactional mutation and append-only outcome audit; migrate or retire legacy mutation paths.
- **Acceptance:** Duplicate and concurrent confirmation tests produce exactly one mutation and stable replay response; execution rechecks user, tenant, role and plan.

### P2 / Medium — Prompt guard and security worker are not complete proof of protection

- **Evidence:** middleware/aiPromptGuard.js and ai/gateway/security.shield.js use deterministic pattern checks/sanitization; utils/securityEmitter.js queues security metadata and jobs/securityWorker.js processes events. Tests in aiPromptGuard.test.js validate known examples. Prompt controls do not authorize tools; role/tenant policy must remain separate.
- **Potential impact:** Pattern detection can miss novel attacks or false-positive benign text. Event enqueue/persistence/worker execution are not runtime verified in this audit.
- **Recommendation:** Keep deny-by-default tools and server authorization authoritative; add adversarial evaluation and test event persistence/worker failure/replay in isolated staging.
- **Acceptance:** Guard tests include adversarial variants and benign controls; no protected data/tool call occurs before denial; event persistence and worker outcome are separately asserted.

### P3 / Low — Multiple AI wrappers and legacy components make reachability hard to reason about

- **Evidence:** services/ai.service.js directly calls Groq with a separate hard-coded model; RAGService is static; legacy ai-chat-bot, ai-copilot, ai-copilot-drawer and services/ai.ts exist. Main active panel is different. Search did not find mounts/callers for several components, while CNC AI activity and separate APIs do have callers.
- **Potential impact:** Future changes can patch an unused route or leave a forgotten bypass. Removal itself risks hidden consumers.
- **Recommendation:** Add a route/component reachability inventory and telemetry before deprecation; remove only after repository-wide caller checks and regression.
- **Acceptance:** All AI routes/components classified active/deprecated with tests/callers; build and browser regression show no broken navigation or assistant access.

## 6. Provider and specialist orchestration

- ProviderFactory reads AI_PROVIDER but returns GroqProvider for groq and default; no other provider adapter is selected in the active primary route. GROQ_API_KEY is required by GroqProvider; GROQ_MODEL configures its primary model. Environment presence and provider health were not checked.
- groq.provider.js uses a shared concurrency limiter and a finite candidate-model fallback list; its client config sets a 10-second timeout and maxRetries 0. Model fallback is not provider redundancy. Authentication/quota/timeout errors are mapped; live provider behavior is unverified.
- The ReAct engine uses up to three model/tool iterations, builds the allowed tool list per context, and catches/wraps tool failures. Multi-scope mode runs several same-provider calls concurrently; global limiter bounds provider calls.
- Plan scope source values: Starter general; Professional general/CNC/inventory/attendance/HR; Enterprise all listed user scopes. Security is not in user model scopes. This is source config, not inspected database plan JSON.
- Auto scope selection falls back to general when the detected specialist is not in the plan. Explicit manual disallowed scopes are rejected. Fast paths execute earlier, which creates the finding above.
- No target numerical latency/cost/token limits were found in approved business policy; only implementation-level timeouts/iteration/concurrency controls exist. Targets need owner approval and staging measurement.

## 7. Conversation persistence and RAG readiness

- Main panel serializes up to 50 conversations in localStorage keyed by user ID; preference settings are also browser-stored. This provides same-browser history, not server-side cross-device persistence, server deletion, expiry, or authoritative access control.
- No dedicated AI conversation/message schema or API was found. Existing messaging conversations are general collaboration and do not establish AI conversation lifecycle.
- RAGService contains hard-coded policy content with string matching; no chunking, embeddings, vector/database index, document ACL checks, versioning, source citations, deletion propagation or active caller were found.
- Customer and employee document APIs exist independently, but their existence does not make them AI retrieval sources. Connector, classification, permission and freshness decisions remain open.
- Implementation should begin only after retention/deletion/audit rules and connector/index technology are decided. Conversation/document migrations require schema inventory, a disposable database, rollback plan and effective application-role RLS tests.

## 8. Customer assistant readiness

The web Customer portal is part of SmartERP-Frontend and is a real portal with its own customerApi/authenticated endpoints. It contains no mounted AI panel or AI caller. Backend LiveSummaryPlugin has a customer-only summary tool that passes context user ID/email/company to AIDataService. This is a future capability, not a delivered user experience. A standalone SmartERP-Customer App Android folder exists but is not version-controlled here; its connection to the deployed customer portal is not established. No customer assistant should be enabled based only on the backend plugin.

Required preconditions: product approval for customer-visible answer domains; trusted customer-to-company/customer mapping; separate customer tool allowlist; explicit request-creation fields and confirmation UX; cross-customer tests; retention/privacy notice; feature-flag and rollback plan.

## 9. Migration and audit-schema findings

- Migration directory contains numbered SQL files through 043 plus non-numbered/lettered files. Duplicate/suffixed identities include 016 and 016b, 021 and 021b; forwardMigrationRunner.js explicitly allow-lists a subset and separates controlled migrations. It is not a generic proof every migration is applied.
- Relevant AI migrations found: 018_ai_copilot_and_audit_logs.sql creates legacy ai_audit_logs and AI-created metadata; 022_cnc_phase3.sql creates ai_action_audit_trail. No AI conversation or document index migration was found in active numbered migration names.
- The current AI telemetry service still executes DDL from logAIAuditEvent, logAIInterception, getAIStats and getAuditLogs via ensureTable. This is request-time schema mutation, regardless of unrelated startup DDL remediation in the latest hardening commit.
- 018 and 022 SQL do not define RLS enablement/policies for the named AI audit tables. Current database RLS/grants/owner roles are unverified. Do not infer that live RLS is off or that data is exposed.
- Generic rls.test.js changes RLS state and executes migration setup; it is not safe for this audit and was not run. Other RLS/two-company tests may require PostgreSQL. No migration or database command was executed.
- Migration history/run behavior should be reviewed against current runner; no AI migration was applied or registered by this audit.

## 10. Safe test results and verification gaps

Executed from backend repository: node --test tests/aiModelEntitlements.test.js tests/aiPromptGuard.test.js

Result: 13 passed, 0 failed, 0 skipped, exit code 0. Tests exercised plan-to-scope selection, deterministic fallback selection, no quota middleware source assertions, prompt sanitization, known injection refusal, benign security education, invalid message rejection, history filtering/bounds, and route guard source assertions. These are unit/source tests; they do not establish API integration, SQL execution, live provider behavior, audit persistence, RLS, browser UI or production behavior.

Not run: frontend tests/build, backend full suite, RLS/two-company suites, database integration, browser tests, live provider tests, migrations, production logs or health checks. Safe reason: broad suite includes tests known by the existing reports to use Redis/PostgreSQL or side effects, while no isolated integration test environment was established. No tests were repaired or weakened.

No live database, external AI provider, production logs, payment provider or secrets/config files were accessed.

## 11. Prioritized risks and dependencies

1. **P1:** Confirm and close deterministic fast-path versus specialist entitlement mismatch. Depends on product plan policy; implement and test before changing tier behavior.
2. **P1:** Gate, retire or canonicalize business-copilot job creation. Depends on authorized role policy and whether feature remains supported.
3. **P1:** Approve internal role/metric visibility and customer-assistant policy. These decisions define permitted data, not just UI.
4. **P2:** Reconcile AI telemetry schema with migration history; prepare reviewed migration and remove runtime DDL after compatibility proof.
5. **P2:** Verify effective DB grants/RLS and test using a non-superuser application role against two tenants.
6. **P2:** Standardize action idempotency and append-only outcome audit across mutation tools.
7. **P2:** Choose conversation retention, deletion and local-history migration policy before persistence schema/UI changes.
8. **P2:** Choose approved document connectors, ACL semantics, index/search technology and deletion propagation before RAG.
9. **P3:** Decide customer assistant launch boundary and Android/web app relationship; keep unmounted features out of availability claims.
10. **P3:** Establish measured latency, cost, token, concurrency, retrieval-quality and alert targets in isolated staging.

## 12. Ticket-by-ticket implementation proposal (AI-001 through AI-508)

The file lists below are likely targets, not edits made by this audit. Dependencies follow the supplied architecture roadmap. For every ticket, acceptance requires safe tests on the candidate revision; DB or provider tickets use isolated environments only.

### Phase 0 — baseline, authorization and release blockers

| Ticket | Problem/evidence | Likely files and dependencies | Minimal scope, tests, migration/risk, acceptance and decision gate |
|---|---|---|---|
| AI-001 | Current route and caller reachability is distributed across active, legacy and disconnected modules. Evidence: server.js, app/layout.tsx, SmartAIPanel, businessCopilot and discovery map. | routes/ai.routes.js, routes/businessCopilot.js, frontend AI components; none. | Maintain active/legacy/caller inventory and route tests. No migration. Risk: deleting false-positive legacy paths; accept only with verified references and explicit classification. |
| AI-002 | Role/plan/tenant/customer matrix is incomplete for fast paths and employee aggregates. | services/aiModelEntitlements.js, services/aiMetricAccess.js, ai/plugins/*; depends AI-001. | Product/security approve matrix; tests for each role, plan, scope and record boundary. No migration. Blocked on owner/security decisions for aggregates/customer. |
| AI-003 | Fast paths run before plan-scope resolution. | routes/ai.routes.js, services/aiMetricAccess.js; depends AI-002. | Enforce approved scope before data calls; direct API tests assert no service call on deny. No migration. Risk of changing plan behavior; policy approval required. |
| AI-004 | Finance/GST/payroll and company-wide aggregate role policies need one source of truth. | ai/plugins/*, services/aiDataService.js, attendance access helpers; depends AI-002. | Explicit role allowlists and tenant predicates; direct API/tool tests. No migration unless schema evidence requires it. Blocked on business data visibility policy. |
| AI-005 | Legacy business-copilot job mutation is separate from canonical action path. | routes/businessCopilot.js, ai/plugins/jobs.plugin.js, confirm-action UI; depends AI-001/002. | Decide retain/retire; if retained add role allowlist, execution recheck and idempotency tests. Migration only if durable action records needed. Blocked on owner workflow approval. |
| AI-006 | AI telemetry schema differs from migration 018/runtime expectations. | ai/telemetry/metrics.service.js, migrations/018*, migration runner; depends AI-001. | Inventory compatible baselines and propose migration; schema contract tests. Migration required after review. No production DB changes until verified backup/disposable environment. |
| AI-007 | Tests do not prove all direct API controls or request-correlated sanitized diagnostics. | tests/ai*, middleware/aiPromptGuard.js, utils/aiErrorResponse.js; depends AI-001. | Add bounded mocked tests and correlation-safe logs; no migration. Accept no prompt/secrets in normal diagnostics and reproducible baseline command. |

### Phase 1 — canonical gateway, security and audit

| Ticket | Problem/evidence | Likely files and dependencies | Minimal scope, tests, migration/risk, acceptance and decision gate |
|---|---|---|---|
| AI-101 | Request/response/action/source/error shapes differ across main and legacy routes. | routes/ai.routes.js, businessCopilot.js, utils/aiErrorResponse.js, frontend smart-ai-panel.tsx; depends AI-001. | Define schemas and contract tests for aliases/errors/actions. No migration. Preserve compatibility until callers verified. |
| AI-102 | Trusted auth context exists but customer identity mapping and all paths need consistent derivation. | auth/customer auth middleware, ContextEngine, customer data services; depends AI-002/101. | Centralize validated user/company/customer context and reject client overrides; spoofing tests. Migration only if identity link schema proven necessary. |
| AI-103 | Specialist plan checks happen after fast paths. | ai.routes.js, aiMetricAccess.js, aiModelEntitlements.js; depends AI-002/102. | Apply policy before fast path/routing/tool calls; direct API matrix tests. No migration. Product plan decision required. |
| AI-104 | Main and legacy action lifecycles differ. | ai.routes.js, ReAct.engine.js, plugin registry, businessCopilot.js, UI; depends AI-005/101/103. | Canonical proposal/confirmation/execution contract; tests for reauthorization and actual persisted result. Schema may be needed for action state. |
| AI-105 | Generic action replay/concurrent confirmation idempotency is not established. | action service/routes, migrations, API client/UI; depends AI-104. | Add actor/company/action key and one-time result semantics; replay/concurrency tests. Migration likely for durable keys; review legacy data and rollback. |
| AI-106 | Runtime audit table shape conflicts with migration 018 and errors are best-effort. | metrics.service.js, migrations, runner; depends AI-006. | Canonicalize schema and event lifecycle; PG insert/read/failed-write tests. Reviewed migration required; do not run before disposable baseline. |
| AI-107 | AI table effective RLS/grants are unknown and migrations do not show AI audit RLS. | migrations, DB verification scripts, RLS tests; depends AI-102/106. | Least privilege, tenant policies; two-company application-role tests. Migration likely. Blocked on disposable PostgreSQL and schema approval. |

### Phase 2 — specialists and provider gateway

| Ticket | Problem/evidence | Likely files and dependencies | Minimal scope, tests, migration/risk, acceptance and decision gate |
|---|---|---|---|
| AI-201 | Tools lack one explicit manifest covering scope, roles, plans, schemas and budgets. | ai/plugins/*, aiPluginScope.js, entitlements; depends AI-101/103. | Add validated manifests and allowlist tests for every registered tool. No migration. Avoid changing tool exposure without approved matrix. |
| AI-202 | Multi-scope Promise.all aggregation has partial/failure semantics but no full orchestration eval. | routes/ai.routes.js, ReAct.engine.js; depends AI-201. | Bound parallelism and define partial/conflict response; mock latency/failure tests. No migration. |
| AI-203 | Provider interface exists but only Groq adapter is wired. | provider.interface.js, factory.js, groq.provider.js; depends AI-101. | Define conformance suite and normalized errors/usage; adapter mock tests. No migration. |
| AI-204 | Approved provider/model privacy and compatibility matrix is not established by source. | config/adapter allowlist/docs; depends AI-203. | Product/security approve providers, models and data handling; config allowlist tests. No migration. Blocked on provider approval. |
| AI-205 | Groq model fallback is not cross-provider failover. | provider.factory.js, provider adapters; depends AI-204. | Configure only approved compatible fallback; transient vs auth/invalid/quota tests. No migration. Must avoid accidental provider data-policy change. |
| AI-206 | No approved cost/token/latency targets; usage budgets and telemetry need verification. | provider adapter, asyncLimiter, metrics.service.js; depends AI-202/203. | Instrument usage/concurrency and enforce approved budgets; load/mocked provider tests. Storage migration only if durable telemetry approved. Targets require owner approval. |
| AI-207 | Deterministic fast-path behavior differs from model tools and their plan gates. | ai.routes.js, AIDataService, model eval tests; depends AI-201/206. | Compare correctness/permissions/latency to tool response; role-plan regression tests. No migration. Acceptance includes no fabricated zeros on errors. |

### Phase 3 — conversation persistence and document RAG

| Ticket | Problem/evidence | Likely files and dependencies | Minimal scope, tests, migration/risk, acceptance and decision gate |
|---|---|---|---|
| AI-301 | Local-only history lacks server lifecycle policy. | product privacy docs, data model proposal; depends AI-101/102. | Approve ownership, retention, deletion and audit exception; policy tests. Schema proposal only. Blocked on retention decision. |
| AI-302 | No server-side AI conversation API/store found. | new conversation route/service, migrations, auth; depends AI-301/107. | Tenant/user/customer-owned CRUD with authorization. PG isolation/deletion tests; migration required; backup/rollback gate. |
| AI-303 | SmartAIPanel uses localStorage as history source. | components/smart-ai-panel.tsx, ai-session-request helper; depends AI-302. | Move history to API, client cache non-authoritative; refresh/cross-device/auth tests. Migration from local data is optional and cannot be silent. |
| AI-304 | Approved document sources/connectors and ACL semantics are unknown. | document subsystem, connector interface/security docs; depends AI-102. | Approve uploads/connectors and permission model; connector capability tests. No migration until chosen. Product/security decision required. |
| AI-305 | No verified ingestion pipeline/version/deletion lifecycle. | new ingestion service/workers, document routes and schema; depends AI-304/107. | Ingest supported files with source/version/classification/status; parser/deletion tests. Schema and worker infrastructure likely; storage risk review. |
| AI-306 | No active permission-aware document retrieval/index found. | retrieval service, index adapter, migrations; depends AI-305/107. | Enforce ACL before passages enter prompt; cross-tenant/revocation tests. Index migration/provisioning depends on approved technology. |
| AI-307 | No verified citations/freshness/no-evidence response for RAG. | retrieval response schema, ReAct context, UI; depends AI-306/203. | Return authorized source references and uncertainty; citation correctness tests. No schema unless source metadata design requires it. |
| AI-308 | No active RAG quality/adversarial evaluation suite. | tests/evals, fixture documents; depends AI-306/307. | Create synthetic multi-tenant/eval corpus and injection cases; relevance/citation/denial tests. No real customer documents. |

### Phase 4 — customer assistant and service requests

| Ticket | Problem/evidence | Likely files and dependencies | Minimal scope, tests, migration/risk, acceptance and decision gate |
|---|---|---|---|
| AI-401 | Customer identity mapping and allowed record policy not formally evidenced. | customer auth middleware, customer service/data model; depends AI-002/102. | Approve customer-to-company/account rules; spoofing and cross-customer tests. Migration only if existing mapping proves insufficient. |
| AI-402 | Existing plugin registry includes internal tools; no customer-only allowlist contract. | new customer AI plugin/registry policy; depends AI-201/401. | Expose only approved customer tools; direct invocation denial tests. No migration unless customer records require linking changes. |
| AI-403 | Web customer portal has no assistant mount. | app/customer layout, customer-specific panel/API helper; depends AI-302/401. | Build opt-in authenticated UI with safe loading/errors; browser tests. No rollout until customer policy/security gate. |
| AI-404 | Customer request creation is not an established AI proposal-confirm-execute flow. | customer AI route/tool/action executor; depends AI-104/105/402. | Validate fields, show proposal, require confirmation, persist idempotently; API mutation tests. May require action schema. |
| AI-405 | Cross-customer/customer mutation integration evidence absent. | backend integration tests, disposable DB; depends AI-403/404/107. | Test two customers and companies, retry/concurrency; DB-backed migration as needed. Blocked on isolated PostgreSQL. |
| AI-406 | Customer AI retention/privacy disclosure is undecided. | customer UI policy and privacy docs; depends AI-301/403. | Approve notices, deletion/retention controls; UX and lifecycle tests. Blocked on product/privacy approval. |

### Phase 5 — pilot and release hardening

| Ticket | Problem/evidence | Likely files and dependencies | Minimal scope, tests, migration/risk, acceptance and decision gate |
|---|---|---|---|
| AI-501 | No complete direct-API role/tenant test evidence across all tools. | backend auth/tool tests; depends AI-103/107/308. | Run role-plan-company matrix on isolated DB; no prod data. Blocked on disposable DB. |
| AI-502 | Provider load/budget/fallback targets are not measured or approved. | load tests, provider metrics/config; depends AI-205/206. | Measure latency/cost/failure under test provider; no live key. Thresholds need owner approval. |
| AI-503 | No browser end-to-end evidence for all portals and assistant flows. | Playwright/browser harness, FE/BE routes; depends AI-303/403. | Verify UI, errors, actions and regressions with host blocklist; no production host. Blocked on approved harness. |
| AI-504 | Production backup/recovery and migration state are not verified by this audit. | migration runbook, backup evidence, schema checks; depends all schema tickets. | Rehearse restore in isolated environment and rollback/forward recovery. No production writes. Release blocker until recovery proof. |
| AI-505 | No signed internal pilot evidence in this source audit. | feature flags, monitoring, pilot checklist; depends AI-501–504. | Limited internal-only rollout after gates; real data access requires approval. No launch inferred from tests. |
| AI-506 | No pilot issue triage/evidence cycle here. | issue log, test suites; depends AI-505. | Fix only approved findings, rerun regressions, document revision. No unrelated redesign. |
| AI-507 | Customer security sign-off is absent. | review evidence, customer isolation tests; depends AI-405/406/506. | Security/product owner sign off on customer-specific boundaries; blocked until all evidence and decisions. |
| AI-508 | Customer pilot flag/rollback control has not been verified. | feature flags, deployment/runbook; depends AI-507. | Verify staged enable/disable and rollback without production customer exposure. Deployment-owner approval required. |

## 13. Acceptance criteria and release gates

### Gate 0 — baseline

- Active frontend mounts, route aliases, tools, legacy routes and configuration names are inventoried against the selected revision.
- Product/security signs the role, plan, company, customer and specialist policy matrix.
- Supported schema baseline, migration state, isolated database identity and recovery plan are verified without production writes.
- Safe baseline tests are reproducible and classified as unit, mock, database, provider, browser or production evidence.

### Gate 1 — authorization foundation

- Fast-path direct API calls and tool routes enforce approved plan/scope/role/tenant policy before reading data.
- Business-copilot mutation is retired or goes through explicit role checks, execution-time reauthorization, idempotency and auditable result persistence.
- Two-company and customer-boundary tests run with a non-superuser application role and prove denial before unauthorized query/mutation.
- AI audit schema, grants and RLS are migration-backed and validated; normal requests perform no DDL.

### Gate 2 — platform

- Each tool has an approved manifest and conformance tests.
- Provider adapters/fallback are explicitly approved and tested; no fallback leaks credentials or silently changes privacy/data policy.
- Budgets and latency/cost targets are based on approved measurements, and total concurrency/retries are bounded.
- Provider exhaustion and data-query failures return honest unavailable results, never fabricated success/zero.

### Gate 3 — data lifecycle

- Server-side conversations enforce user/company/customer ownership, retention and deletion.
- Document retrieval checks ACLs before prompt composition and honors update, revoke, version and delete state.
- Answers cite authorized evidence and abstain when evidence is missing; malicious document instructions cannot change authorization.

### Gate 4 — customer readiness

- Customer chat is mounted only in the approved portal, using trusted customer identity and a customer-specific tool allowlist.
- Cross-customer reads and writes are denied; service requests require confirmation and idempotent persistence.
- Retention/privacy UX and customer-specific security sign-off are complete.

### Gate 5/6 — pilot and customer pilot

- Isolated DB migration/recovery rehearsal, browser desktop/mobile regression, provider load/failure tests, observability and rollback have evidence tied to a source revision.
- Internal pilot sign-off precedes customer pilot sign-off. A successful build or mocked unit test alone cannot pass either gate.

Automatic blockers: cross-tenant or cross-customer disclosure; unauthorized mutation; plan/role bypass; unapproved provider; unavailable ACL enforcement; duplicate mutation; unverifiable required audit; unknown production migration state or recovery path.

## 14. Product/security/deployment-owner decisions

1. Which roles may see company-wide job and attendance aggregates? Are these metrics permitted for Employee and HR, and do any employee-level details require separate policy?
2. Which specialist scopes and deterministic summaries belong in each subscription tier? Should an entitled general assistant be able to invoke a deterministic finance/attendance/inventory fast path if the corresponding specialist model is not included?
3. Should business-copilot job creation be retired or retained? If retained, which roles can propose and execute it, and what confirmation/idempotency policy applies?
4. Should Customer AI be offered? Which customer records, documents, and service actions may it access/create, and what is the customer-to-ERP mapping authority?
5. What conversation retention, deletion, audit exceptions and optional local-history migration policy is approved?
6. Which document connectors/file types are approved; do their ACLs map to company/user/customer audiences? Which search/index technology and hosting/data residency are acceptable?
7. Which model providers/models are approved, in what fallback order, and with which data privacy and cost rules?
8. What latency, cost, token, concurrency, retrieval-quality and alert targets should be used after staging measurement?
9. Which database owner confirms the supported schema baseline, migration state, least-privilege application role, backup and recovery rehearsal?
10. Which security/QA/deployment owners approve the source revision, staging test evidence, pilot flag and rollback procedure?

## 15. Recommended implementation order

1. Resolve the fast-path scope/plan policy and test it at the direct API before data access.
2. Gate or retire business-copilot job creation; if retained, add role authorization and idempotent execution.
3. Approve role/tenant/customer data policies and test every read/tool route.
4. Reconcile AI telemetry schema and grants/RLS through a reviewed migration; remove request-time DDL only after schema compatibility is proven.
5. Complete action lifecycle and replay protection.
6. Add provider adapter conformance, approved fallback, budgets and operational metrics.
7. Add server-side conversation lifecycle after retention decisions.
8. Build permission-aware document ingestion/RAG after connector, ACL and index decisions.
9. Add Customer assistant only after separate customer policy, tools, UI and two-customer verification.
10. Run integration/browser/performance/recovery gates, then consider internal pilot; customer pilot follows separate security approval.

**Final audit status:** Source audit complete for the inspected repository scope. No implementation was started. Findings and ticket scopes require human review; production readiness is not claimed.
