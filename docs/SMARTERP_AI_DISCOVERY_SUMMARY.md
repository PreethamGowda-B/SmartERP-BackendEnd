# SmartERP AI — Discovery Summary

**Scope:** current source in `SmartERP-Frontend` and `SmartERP-BackendEnd`, including uncommitted working-tree changes. No production database, provider, logs, or deployed revision were accessed.

## What exists

- A shared floating assistant (`FloatingActionHub` → `SmartAIPanel`) for signed-in Owner, Employee, HR and potentially Super Admin accounts when the plan context enables `ai_assistant`.
- A backend `/api/ai/agent` path with authentication, plan checks, prompt/history sanitization, deterministic ERP summaries, specialist-scope routing, a bounded ReAct tool loop and a Groq SDK provider.
- PostgreSQL-backed job, attendance, leave, inventory, finance, HR, customer and CNC helpers, with many company/user predicates and role/plan/scope checks.
- A separate Super Admin AI Operations metrics/audit UI and a distinct security incident enrichment path.
- A customer summary plugin, but the current shared chat UI hides `/customer*` and no customer chat mount was found.

## What tests support

- Backend focused AI checks: **50 passed, 0 failed** across assigned jobs, attendance access, tenant-scoped data queries, low-stock, scope entitlements, prompt guard, provider mocks, quota and safe errors.
- `node tests/ai.tenant.test.js`: passed its three source/service fail-closed checks.
- Frontend `node --test tests/ai-session-request.test.mjs`: **6 passed** with a mocked client.
- These are mocked/source-level checks, not live Groq, PostgreSQL/RLS, browser, staging or production verification.
- The legacy subscription test emitted a Redis-connected message and remained alive after its failing assertions; it was interrupted. No intentional Redis/business-data mutation was part of the assertions, but a Redis connection was established and the test is reported failed/interrupted.

## Broken, inconsistent or risky in source

- `ai_subscription_rbac.test.js` fails three legacy plan-gating/RBAC expectations because it asserts `free/basic/pro`; current backend tiers are `starter/professional/enterprise`.
- Deterministic AI data fast paths run before specialist plan-scope checks. `canUseAiFastPath()` checks role only, so source does not establish lower-tier blocking on every specialist fast path.
- Completed-job counts and attendance summaries are company-wide for roles that include Employee; whether that aggregate disclosure is intended needs policy confirmation. Personal assigned-job queries remain employee-filtered.
- Frontend labels “Basic/Pro” are mapped to Professional/Enterprise, which differs from backend names and old tests.
- The “multi-agent” UI fans out scope-specific runs through the same Groq provider; there are no independent model providers in the primary path.
- AI audit schema in migration 018 differs from the runtime insert shape in `MetricsService`; runtime DDL is attempted on request paths and ALTER errors are swallowed. Actual deployed audit persistence is unverified.
- AI migrations 018/022 do not themselves enable RLS for the AI audit/action/memory tables; current database RLS status was not inspected.
- `businessCopilot.js` has a separate direct job-creation workflow after a confirmation boolean; a clear role allowlist and retry idempotency are not shown, and timeline write failure is ignored. Its active UI mount was not verified.
- `ai/rag/rag.service.js` and `services/ai.service.js` appear disconnected. The RAG helper contains static policy text, not embeddings or live document retrieval.
- Super Admin `SecurityPlugin` tools are registered but `security` is not an allowed standard model scope. Security incident enrichment uses a separate route/provider path.

## What is still unknown

- Whether these local uncommitted source changes are committed or deployed.
- Current provider configuration/availability, database schema, RLS/grants, audit persistence, and deployment environment.
- Current production error root causes or latency/cost metrics.
- Browser/mobile accessibility behavior and customer-facing AI requirements.

See [SMARTERP_AI_CURRENT_STATE.md](SMARTERP_AI_CURRENT_STATE.md) for source map, all portal coverage, tool catalog, request traces, eight diagrams, data and security boundaries, configuration names, and exact test commands/results.
