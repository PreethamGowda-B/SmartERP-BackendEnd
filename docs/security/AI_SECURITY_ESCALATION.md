# SmartERP AI request safety and prompt-injection escalation

## Request behavior

- The shared server-side prompt guard screens the new prompt before the agent, chat, and copilot handlers. Action-confirmation parameters use the same `SecurityShield` detector before plugin execution.
- A detector-confirmed prompt injection is rejected with `AI_PROMPT_BLOCKED` and a fixed refusal. The raw prompt is not included in the security event; only the detector category, request correlation ID, and message length are recorded.
- Unsafe prior chat turns are omitted from model context. They do not create a new incident by themselves and do not block a safe current request.
- Normal business queries continue through authenticated role, plan, and company-scoped services. A provider/data/tool failure returns a categorized error instead of a fabricated successful answer.

## Escalation policy

- Defaults: 16 verified events in a rolling 15-minute window, from the same authenticated user and company.
- Attempts 1–15 are blocked and recorded. They do not throttle the source IP, revoke sessions, or suspend any account.
- At the threshold, the default behavior creates a `USER_SUSPEND` action requiring explicit Super Admin approval. Super Admin accounts and company mismatches are excluded.
- `AI_PROMPT_INJECTION_THRESHOLD` and `AI_PROMPT_INJECTION_WINDOW_MINUTES` accept bounded integer overrides (2–1000 attempts; 1–1440 minutes).
- Automatic suspension is disabled unless `AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED=true` is explicitly configured. When enabled, the security worker executes only the pending action that carries the verified threshold evidence; the executor rechecks the flag, threshold, account role, company, session store, and current action state under the account-state lock.
- Redis session storage and the security worker must be healthy for automatic suspension. If they are unavailable, the account is not suspended; the action remains available for review/retry according to its persisted state.

Do not enable automatic suspension in a production environment until the 16-attempt workflow, session revocation, login/refresh rejection, unrelated-account isolation, and Super Admin reactivation have passed in an isolated integration environment and the owner/security approver has accepted the policy.

## Verification boundary

The unit tests exercise guard behavior, policy thresholds, response mapping, and source contracts. They do not verify a live database, Redis, provider request, security-event persistence, worker queue, browser UI, or deployed environment. Those require an explicitly isolated test stack and a staging deployment.
