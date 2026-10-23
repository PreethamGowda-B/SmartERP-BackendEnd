# SmartERP Prompt-Injection Detection and Auto-Response Audit

**Audit date:** 2026-10-23
**Overall status:** PARTIALLY VERIFIED
**Scope:** Current local source, supplied Render log excerpts, and isolated mocked/unit tests. No production database, Render control plane, or deployed endpoint was queried.

## Executive finding

The supplied Render logs do not include the reported 06:22 AM IST request. They end at `2026-10-23T00:31:52.503Z` (06:01:52 AM IST); the requested 06:22 AM IST corresponds to about `00:52Z`. That excerpt contains an earlier `SmartERP AI Agent Error: 42703`, a PostgreSQL undefined-column SQLSTATE. It does not establish the status or failure cause of the later resilience test.

Source distinguishes the likely outcomes:

- A detector rejection returns HTTP 400 with `code: AI_PROMPT_BLOCKED`, before AI quota consumption, provider calls, or business tools. Authentication/account-state and plan checks run before this guard and can perform their own database reads.
- An uncaught SQL error in the agent handler returns HTTP 500 with `code: AI_AGENT_FAILED`. The earlier logged `42703` is consistent with this path, not a deliberate guard rejection and not a provider error. It is not proven to be the 06:22 request.
- Provider-unavailable errors are handled separately as HTTP 503. No supplied log ties a provider failure to the reported test.

The source had a schema-compatibility defect in `services/aiDataService.js::getHrDashboardSummary()`: its headcount query referenced `users.status` directly, although other current queries explicitly tolerate that optional column being absent. The fix reads the optional status through `to_jsonb(u)` and preserves the same active/suspended filtering. A mocked regression test simulates a legacy `users` relation without `status`, rejects direct `u.status` references with SQLSTATE `42703`, and verifies headcount remains available. This is a plausible cause of an HR payroll-summary `42703`, but does not identify the unlogged 06:22 request; PostgreSQL-backed verification was not run.

Before this audit's local patch, the copilot route did not use the shared guard, the agent screened only the latest `message` (not client-provided history or system-prompt UI context), and nested action parameters were not inspected. Prompt security events were asynchronously persisted but were not queued for the normal BullMQ worker. A standalone polling worker exists in source, but its deployment is unverified.

## 1. Incident-specific evidence (06:22 AM)

| Question | Finding |
| --- | --- |
| Exact HTTP status | **NOT VERIFIED.** No request-correlated access log or browser network record for 06:22 is present. |
| Backend exception/failure point | **NOT VERIFIED for 06:22.** The available 06:01:52 log reports SQLSTATE `42703` from the agent catch path. PostgreSQL `42703` means undefined column; it is not emitted by the prompt guard or Groq adapter. |
| Guard deliberate rejection? | **NOT VERIFIED for 06:22.** A deliberate rejection is source-defined as 400 `AI_PROMPT_BLOCKED`; no such log is present. The earlier `42703` was not a guard rejection. |
| Event persisted? | **NOT VERIFIED.** No database read or event-specific log was supplied. The old emitter logged DB insert failures but did not return a persistence result to the request. |
| Worker processed it? | **NOT VERIFIED.** No matching worker/job/incident log or live worker health result was supplied. |
| Tools or business queries before failure? | If the guard rejected the prompt, no AI tools/provider/business-data queries ran; auth and plan reads happen before it. If the guard accepted it, source permits fast-path SQL or ReAct provider/tool execution, so the 42703 could have occurred after earlier query work. Exact request path is unknown. |
| Frontend message | **Confirmed from source:** `components/smart-ai-panel.tsx` maps generic non-503 API failures to “The AI request could not be completed. Please retry in a moment.” It therefore hides the safe API error detail for a 500. Guard 400 responses were also previously rendered generically. The new local UI patch gives a clear, safe message for `AI_PROMPT_BLOCKED`; generic server failures remain generic by design. |

The previous supplied Render excerpt also contains repeated `AI attendance summary unavailable: column u.status does not exist`. The current checked-out attendance summary uses `to_jsonb(u)->>'status'` to tolerate a missing optional column. This earlier log indicates the deployed code/schema at that timestamp was incompatible or differed from this local source. It is separate evidence and cannot be attributed to the 06:22 prompt test.

## 2. AI entry-point coverage

Routes are mounted under both `/api` and `/api/v1` in `server.js`.

| Entry point | Source behavior and finding |
| --- | --- |
| `POST /api/ai/agent` | Authentication, plan and feature checks, shared prompt guard, then quota and handler. Guard blocks before model/tool execution. It originally checked only the current `message`; local patch also validates supplied history and context strings incorporated into the generated system prompt. |
| `POST /api/ai/chat` | Same middleware guard and quota ordering. This route invokes the ReAct engine after the guard. |
| `POST /api/ai/confirm-action` | Authentication/plan/quota followed by inspection of action params before plugin execution. Before local patch only top-level string parameters were inspected; local patch recursively inspects nested objects/arrays and rejects excessive nesting. Registry/tool authorization remains a separate required control. |
| `POST /api/ai/copilot` | Separate business workflow route. **Confirmed source bypass before patch:** did not use shared input validation and could reach a confirmed job insert. Local patch adds guard for the `prompt` field before quotas/workflow logic and uses the sanitized value throughout. |
| `GET /api/ai/predictive-maintenance`, `POST /api/ai/auto-schedule` | Authenticated structured-data analytics/recommendation routes; neither accepts a conversational prompt nor directly calls an LLM in the inspected implementation. They are not prompt-guard entry points, but their ordinary authorization and tenant scope still need independent review. |
| Invoice OCR (`services/ocrService.js`, called from material purchase workflow) | Document/image content is sent as untrusted data with explicit system instructions to ignore document instructions; output is schema-normalized before use. This is prompt-injection mitigation, not the same detector or incident pipeline. No isolated adversarial-document integration test was run. |
| RAG and internal AI services | `ai/rag/rag.service.js` currently returns static platform guidance. Inventory forecast, GST reconciliation, AR collection, and security analysis make structured/internal-data provider calls; they do not expose a general raw prompt route in the inspected call sites. Stored field/document prompt injection resistance is not comprehensively integration-tested. |
| Customer chat/document uploads | Chat attachments are stored and shared with an authorized job conversation; no direct LLM processing was found in that route. |

The detector in `ai/gateway/security.shield.js` is a deterministic raw-text pattern set for overrides, secret extraction, destructive SQL, cross-company access phrases, and framing delimiters. It has an educational-question exception. It does **not** prove resistance to encoded, multilingual, semantic, or arbitrary multi-step attacks. The new guard checks all supplied history text and the UI values inserted into the generated system prompt; it is still a pattern filter, not a complete injection-proof model boundary.

## 3. Changes in the reviewed source

The two worktrees were clean on `main` before the initial edits. The backend and frontend source changes were later committed and pushed to `main`; push verification is recorded below. Deployment remains unverified.

- `middleware/aiPromptGuard.js`: supports configurable prompt field; validates current message, prior history, and relevant client UI context; records only detector-confirmed attacks with redacted metadata and a correlation identifier. Oversize/shape failures no longer count as malicious events.
- `routes/ai.routes.js`: applies history/context screening to agent/chat; recursively checks nested confirmed-action parameters; adds safe PostgreSQL SQLSTATE diagnostics without logging prompt text or parameter values.
- `routes/businessCopilot.js`: closes the alternate prompt-guard bypass and uses only its sanitized prompt value.
- `services/aiDataService.js`: avoids the undefined optional `users.status` column in the HR AI headcount query while preserving its intended filter.
- `utils/securityEmitter.js`: after a prompt event is successfully inserted, enqueues it for the configured security worker; database and queue failures are logged. Without Redis it explicitly warns that the standalone database poller must be running.
- `jobs/securityWorker.js`: counts only detector-confirmed prompt events for the same authenticated user and company as actionable evidence.
- `utils/securityPolicyEngine.js`: a single blocked prompt now logs for review without automatic containment; three verified attempts trigger reversible temporary IP throttling and session revocation. Account-suspension proposals require at least five verified attempts across two detector categories and risk score at least 90, and still require Super Admin approval.
- `SmartERP-Frontend/components/smart-ai-panel.tsx`: provides a safe explanatory message for a guard rejection rather than showing the generic retry message.
- `tests/aiPromptGuard.test.js`, `tests/promptInjectionResponse.test.js`: add mock/source-contract regression coverage.

### Exact local containment policy after this patch

1. One detector-confirmed prompt: block request, asynchronously record event, no automatic IP throttle or session revocation.
2. At least three detector-confirmed events in the worker's 15-minute window, attributed to the same user and company: temporary 30-minute IP throttle and refresh/access-session revocation through Redis.
3. At least five events, at least two distinct detector categories, and risk score at least 90: create a **pending** account-suspension action for Super Admin review. No automatic account suspension is performed.
4. Super Admin targets are protected by a policy check and a second executor check.

Because detector categories are regex-derived, these counts are operational thresholds, not proof of attacker identity. Automatic account suspension remains intentionally approval-gated. A manual Super Admin action can suspend an eligible account; executor source updates `users.is_active`, revokes refresh tokens, and sets Redis revocation/suspension keys. Authentication middleware checks account state on protected requests; password login, Google staff callback, and refresh paths also check inactive state. These are source findings, not live end-to-end tests.

## 4. Event pipeline and worker evidence

### Source-confirmed

- Guard rejection does not pass the request to the agent, copilot, chat, or action execution handler.
- Security event insertion uses `security_events` and sets `created_at = NOW()`; identity and company are taken from authenticated `req.user`. The detector does not store raw prompt text. Metadata includes detector category/reason, risk level, length, and a generated/request correlation identifier.
- The emitter is intentionally asynchronous. Insert failures are logged; a failed event write does not unblock the rejected prompt, but it can prevent subsequent automated response.
- The security worker reads 15-minute event windows, creates/updates deduplicated incidents, evaluates policy, and executes automated actions. The local change queues a prompt event only after its DB insert succeeds.
- `jobs/workers.js` attaches the BullMQ worker when Redis is configured and the app starts background workers. `jobs/securityWorkerStandalone.js` contains a DB polling fallback only when Redis is offline.
- `routes/security.js` protects security endpoints with token authentication and Super Admin authorization.

### Not verified

- Whether the deployed Render service has the expected backend revision, Redis URL, background worker setting, or a separate `node jobs/securityWorkerStandalone.js` worker.
- Whether Redis is available in the deployed environment and BullMQ is processing prompt events.
- Whether the production `security_events`, `security_incidents`, `security_actions`, RLS policies, grants, and migration ledger match tracked SQL.
- Whether the reported 06:22 request created an event, incident, or action.

`migrations/043_security_infrastructure_hardening_and_rls.sql` creates/adjusts security table policies and grants in source. `forwardMigrationRunner.js` lists 043 as a controlled migration excluded from startup migrations. Registration is not proof it was applied. No production schema or ledger was queried. The migration's grants and RLS behavior still need approved disposable-PostgreSQL verification, especially under the actual non-owner application role.

The health endpoint reports a BullMQ worker object state, not proof that jobs were consumed. It currently can fall back to empty telemetry and zero incident summaries on query failure and still return an overall `healthy` status; do not treat that endpoint alone as evidence of monitoring.

## 5. Tests and commands

All executed tests were local source/unit checks with no database writes. No staging or production request was sent.

- `node --check tests/aiDataServiceTenantScope.test.js` — **PASS**, exit 0.
- `$env:REDIS_URL=''; node --test tests/aiPromptGuard.test.js tests/promptInjectionResponse.test.js tests/aiDataServiceTenantScope.test.js tests/aiAttendanceSummaryAccess.test.js` — **PASS**, 21 passed, 0 failed, 0 skipped. Redis was disabled for this run; database calls in these tests were mocked.
- `git diff --check` in backend and frontend — **PASS**, no whitespace errors.
- Frontend local `tsc --noEmit` — **PASS**, exit 0.

The first focused test invocation inherited a Redis URL and opened Redis client connections on module import; the test runner was stopped and rerun with Redis disabled. The tests did not enqueue jobs or mutate database/business data. Because the endpoint identity was not inspected, the destination of that initial connection is **unknown**; it is not represented as an isolated integration test.

Not run: PostgreSQL-backed validation of the missing-column query, security worker queue consumption, account-suspension executor integration, browser tests, Render/staging verification, production migration checks, adversarial document integration tests, or real payment/provider tests.

## 6. Prioritized issues and next steps

### P0 — deployment and runtime proof missing

- Get request-correlated Render logs/access records for approximately `2026-10-23T00:52Z`, including request status, route, error code and worker logs. Do not include tokens or prompt contents.
- Verify the deployed commit and whether the standalone worker exists. Require a worker heartbeat plus a synthetic isolated event processed end-to-end before asserting automation is active.
- Inspect migration 043 ledger/schema/RLS/grants read-only under an approved project; then test under a disposable non-superuser role. No database connection was used here.

### P1 — backend code still needs broader verification

- Run mocked tests for nested confirm-action params, queue failure, DB persistence failure, worker retry/restart idempotency, revoked access JWT, refresh rejection, login/Google rejection, and Super Admin non-suspension.
- Run isolated PostgreSQL/Redis tests only after a disposable environment and safe identity are confirmed.
- Review the raw-regex detector against benign security research and encoded/indirect test cases. Do not infer complete protection from these pattern tests.
- Consider an approved policy decision before changing the pending Super Admin approval requirement for suspension.

### P2 — diagnostics and observability

- Add a trusted request ID at ingress and propagate it through API logs, security event metadata, BullMQ job payload, incident and frontend diagnostics. Current event metadata generates an ID when none exists, but it is not yet linked to all logs/database rows.
- Make security health return degraded/unavailable when telemetry queries fail; current empty/zero fallbacks can look healthy.
- Verify log retention and alerting for event insert, enqueue, and worker failures.

## Final answer: what happens today?

For the deployed service at the time of the reported 06:22 test, the supplied evidence is insufficient to say exactly what happened. Source says a recognized malicious prompt is rejected with HTTP 400 before AI tools run; authentication and plan checks may already have read their own state. A nonmatching/educational request can proceed to live data queries and/or the provider. The available earlier 06:01:52 log shows a different agent failure with SQLSTATE 42703, which returns HTTP 500 in source; it is not evidence of the later request.

No supplied evidence verifies that the 06:22 event was persisted or processed, and no production automatic suspension is verified. In current source, even a sufficiently corroborated suspension candidate remains pending Super Admin approval.

## Follow-up repository and deployment status

At the follow-up check on 2026-10-23, the backend repository was clean on `main` at `b12eaf972859227ff5b3128248e86f65029b95c9` (`origin/main`), and the frontend repository was clean on `main` at `cd21836bc6d1e07379ee82551d15a5927963d867` (`origin/main`). These commits prove GitHub delivery only, not deployment. No Render CLI or Render log connector was available, and the supplied log excerpt ends at `00:31:52.503Z`. Therefore the deployed revision, 06:22 request status, event persistence, and worker processing remain unverified. No production customer data was accessed.

The missing-status regression test and follow-up report updates were included in the current follow-up commits and pushed to the existing main branches. The regression result is mocked application-test evidence, not PostgreSQL integration evidence.

## AI availability and plan follow-up

The reported AI `/agent` responses use HTTP 400, which is consistent with input validation or the prompt guard, not the former plan message quota. The quota returned 429 when exceeded or 503 when Redis could not verify the quota. The frontend sends the prior ten conversation turns; before the follow-up fix, one unsafe or over-3,000-character history entry caused every later safe prompt in that conversation to be rejected. The guard now omits unsafe/oversized prior turns, caps considered history to the latest 20, normalizes sender roles, and still blocks a malicious current prompt. The exact failing request body was not available, so this is a source-confirmed failure mechanism, not a verified attribution to either owner account.

The per-hour AI message quota was removed. Starter now has the basic `general` assistant; Professional has `general`, CNC, inventory, attendance, and HR scopes; Enterprise has all user-facing specialist scopes. Backend direct API scope checks mirror those entitlements. The old keyword-only Enterprise topic block was removed. Existing role authorization, tenant scoping, job creation limits, and confirmed-action checks remain separate. These specialist scopes are different prompts/personas using the configured provider integration; this source change does not configure a different provider model ID per plan.

The reported CORS failure on `/api/jobs` is separate from AI plan quotas and prompt screening. Tracked backend CORS configuration explicitly permits `https://www.prozync.in` and `*.prozync.in`; the missing `Access-Control-Allow-Origin` header therefore needs request-time service/proxy logs to determine whether the request reached the expected backend revision. No CORS allowlist was broadened in response to the browser error.

Follow-up verification after these changes: 27 focused backend tests passed with Redis disabled and database calls mocked; frontend TypeScript passed. No Render request logs, staging request, PostgreSQL integration, or production deployment verification was available. The availability/model changes were committed and pushed to the existing main branches on 2026-10-23; deployment remains unverified.
