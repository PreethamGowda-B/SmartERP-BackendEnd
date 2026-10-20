# SmartERP Subscription Implementation and Verification Report

**Updated:** 2026-10-20
**Scope:** Subscription source implementation, feature-entitlement review, local verification, and Git delivery.
**Overall status: PARTIALLY COMPLETE.** Source safeguards exist, but inventory/storage quotas have no verified route enforcement, commercial entitlement decisions and database provisioning remain unresolved, and the end-to-end payment lifecycle is untested. The system is not ready for pre-launch acceptance or production payments.

## 1. Plan catalog and pricing

The backend code catalog is the source for stable plan IDs and prices in SmartERP-BackendEnd/services/subscriptionCatalog.js. The public catalog endpoint serves canonical names and prices from that code and reads feature/limit configuration from the database.

| ID | Plan | Monthly | Annual | Employee cap in source | Other source limits |
|---:|---|---:|---:|---:|---|
| 1 | Starter | ₹0 | ₹0 | 10 | 15 active jobs; 50 inventory items fallback; 250 MB storage fallback |
| 2 | Professional | ₹999 | ₹9,990 | 50 | 100 active jobs; 500 inventory items fallback; 5 GB storage fallback |
| 3 | Enterprise | ₹2,499 | ₹24,990 | Unlimited | Unlimited job, inventory, and storage limits in the source fallback |
| Trial | Enterprise features for 30 days after a ₹1 captured payment | One-time ₹1 | N/A | Uses Enterprise row | Feature values are still read from the Enterprise plan row |

These limits describe current source behavior. The product brief explicitly sets Starter's 10-employee cap and plan prices; the other quotas are carried forward from existing backend code. They still need owner confirmation before being advertised as commercial entitlements.

The plan table in tracked schema.sql contains features JSONB and limit columns, but no source migration or seed was found that guarantees rows 1, 2, and 3 exist. The test-plan setup script is database-mutating and was not run. GET /api/subscription/plans requires all three rows and returns 503 if any is missing. The route calculates prices from code; plan feature values and some limits come from database rows. No database rows were inspected.

## 2. Subscription lifecycle implementation

### Source-confirmed behavior

- New owner registration paths assign Starter (plan ID 1); employee registration paths check the employee cap.
- Paid checkout accepts Professional or Enterprise and monthly or yearly cycles. The backend derives amount in paise from the catalog; it does not trust a client amount.
- Payment verification validates the checkout HMAC, fetches the order and payment from Razorpay, then checks captured status, amount, currency, order association, company, plan, cycle, and purchase purpose before applying a paid plan.
- The ₹1 trial has separate order purpose and plan metadata. Activation requires a captured INR 100-paise payment verified by the provider. The 30-day expiration is set server-side.
- Trial and paid payment callbacks use PostgreSQL advisory locks and company-row locks, write subscription events in a transaction, and invalidate the plan cache after commit.
- The signed webhook verifies the raw-body signature and fetches the associated order/payment before applying a plan.
- Plan loading checks trial/paid expiration and bounds cache TTL by remaining entitlement time. The trial-expiry worker downgrades expired trials to Starter.
- Super Admin plan override routes validate plan IDs and paid-plan expiry, lock the company, write an audit event, and invalidate cache. The alternate override path was brought into line with these protections in this work.
- Frontend plan labels now use stable plan IDs and canonical Starter / Professional / Enterprise names, rather than interpreting stale database labels such as Basic or Pro.

### Unsupported or incomplete lifecycle paths

- No Razorpay test-mode request or live payment was performed. Unit tests exercise local signature/order matching helpers only.
- No database unique constraint was verified for provider payment IDs or one trial per company. Current duplicate checks rely on transaction-level advisory locks and event lookups; that is not verified against the actual deployed schema.
- The company-level trial policy does not prove that a different company record belongs to a different real-world business.
- Cancellation, automatic renewal, disputes, settlement reconciliation, and provider-backed refunds are not complete or verified.
- Subscription history is read from the subscriptions table, but successful upgrade/trial code writes subscription_events; provider payment IDs are not stored in the displayed subscription record.
- The previous Super Admin refund action changed a local subscription status and reported success without calling Razorpay. That false-success path is now blocked: the endpoint returns 409 PAYMENT_REFERENCE_REQUIRED and does not mutate the record. The billing UI labels the list as subscription records and shows refunds as unavailable until a verified provider reference is stored. No actual refund is supported by this ledger.

## 3. Feature entitlement inventory

A role permission answers who may use an operation. A plan entitlement answers whether the company plan includes it. These checks are separate. Company scoping and existing route authorization remain required regardless of plan.

The source schema stores feature decisions in plans.features JSONB. Because there was no approved read-only database connection, no actual Starter, Professional, Enterprise, or trial feature JSON values are asserted below.

| Module / feature | Portals | Current assignment source | Backend enforcement found | Current status |
|---|---|---|---|---|
| Employee seats | Owner, HR, employee registration | Canonical catalog: Starter 10, Professional 50, Enterprise unlimited | checkPlanLimit(employee) on employee creation paths; registration paths use the canonical cap and advisory locking | Source-enforced on inspected creation paths; DB/runtime unverified |
| Active job creation | Owner, Customer, Employee workflows | Canonical catalog: Starter 15, Professional 100, Enterprise unlimited | checkPlanLimit(job) on owner/customer job creation and inspected job-producing actions; advisory lock serializes bounded creation | Source-enforced on inspected paths; other job mutations are not all quota-gated |
| Inventory item count | Owner, Employee | Database max_inventory_items, with source fallback 50 / 500 / unlimited | Limit calculation exists, but no checkPlanLimit(inventory) caller was found in the route scan | **Not enforced on the inspected write paths** |
| File storage | Multiple portals | Source fallback 250 MB / 5 GB / unlimited | Limit calculation exists, but no checkPlanLimit(storage) caller was found | **Not enforced on inspected write paths** |
| AI assistant entry points | Owner, Employee | Database features.ai_assistant; unknown until plan rows are inspected | /api/ai/agent, /api/ai/confirm-action, legacy /api/ai/chat, and business copilot routes require the feature and quota | Guarded when the flag is false/missing; DB configuration unverified |
| AI request quota | Owner, Employee | Current source: Starter 5/hour, Professional 15/hour, Enterprise 30/hour | Redis Lua script performs an atomic increment and expiry; missing user, unknown plan tier, Redis outage, malformed result, or Redis error fails closed | Source/unit-tested; quota values need owner confirmation; Redis runtime/concurrency unverified |
| AI specialist tools | Owner, Employee | Current hardcoded source tiers: Starter navigation only; Professional excludes selected Financial/GST, forecasting, validation, and AR tools; Enterprise allows registered tools | Plugin registry filters tool listing and checks direct execution; role checks also apply to finance/payroll tools | Source-enforced tier rules; these assignments are not backed by the plan feature JSON and need owner approval |
| Payroll and payroll validation | Owner, HR | Database features.payroll; unknown by plan | Payroll reads/writes and payroll-validation router require the flag plus route-specific role/permission checks | Guarded on inspected APIs; database values and complete route coverage unverified |
| Advanced reports / executive BI | Owner, HR, Employee | Database features.advanced_reports; unknown by plan | Selected report and Executive BI APIs require the flag; personal report APIs do not | Partial route coverage; plan values unknown |
| Location tracking | Owner, Employee | Database features.location_tracking; unknown by plan | Owner tracking reads require the flag; employee location update checks the flag and returns a disabled response when unavailable | Guarded on inspected paths; UI/runtime behavior and database values unverified |
| Accounts receivable collections | Owner | Database features.ar_collections; unknown by plan | AR collections router requires the flag | Backend guarded; no verified plan configuration |
| Inventory forecasts | Owner | Database features.inventory_forecasts; unknown by plan | Forecast router requires the flag | Backend guarded; no verified plan configuration |
| Attendance, shifts, leave, HR requests | Owner, HR, Employee | No verified plan assignment | Role/policy checks exist, but no general plan feature guard was found | Plan assignment/enforcement unknown |
| Materials, purchasing, suppliers | Owner, Employee | No verified plan assignment | Core material/inventory route set is not consistently plan-gated | Plan assignment/enforcement unknown |
| Production, quality, packing, dispatch | Owner, Employee, Customer | No verified plan assignment | Production APIs were not found behind a plan feature guard | Plan assignment/enforcement unknown |
| Customer jobs and manufacturing requests | Customer, Owner, Employee | No verified plan assignment | Customer job creation has an active-job quota; broader manufacturing request routes have no verified feature assignment | Partial quota enforcement; feature assignment unknown |
| Invoices, payments, GST, finance | Owner, Customer | No verified plan assignment | Historical invoice access is not restricted by a new plan guard; role and tenant checks still apply. GST/finance AI tools have tier-specific plugin rules | No complete route-level plan audit; preserve existing records |
| Messaging and notifications | All portals | Existing code has no general plan feature guard; source comments describe message access across plans | Auth, role, and tenant checks apply independently | No plan-based restriction found; actual message-retention configuration is database-dependent |
| Machines, CNC/SLA, telemetry | Owner, Employee | No verified plan assignment | No complete plan guard inventory found | Plan assignment/enforcement unknown |
| Support and remote assistance | Owner, Employee | No verified plan assignment | Support and job-creating paths have mixed checks; no complete module entitlement coverage | Plan assignment/enforcement unknown |
| Super Admin billing and overrides | Super Admin | Platform operator capability, not a customer subscription feature | Super Admin router authorization; override validation/audit/cache handling is source-enforced | Source-confirmed; runtime DB behavior unverified |

### Current database-backed feature keys used by code

Inspected guarded feature keys are ai_assistant, payroll, advanced_reports, location_tracking, ar_collections, and inventory_forecasts. A missing or non-boolean true flag is denied by the shared feature guard. The code does not establish which plan rows contain these flags.

The absence of a feature guard is not evidence that the product team intentionally includes a feature in every plan. The unguarded rows above need an owner decision and a complete route mapping before feature-based marketing.

## 4. Frontend billing and entitlement behavior

- Public pricing fetches /api/subscription/plans; it does not show a fabricated feature list when the live catalog is unavailable.
- Owner billing loads plan/status data from the backend and uses backend checkout routes.
- The payment-success page requires payment callback values and backend verification; a query-string success value alone cannot activate a plan.
- Subscription context maps stable IDs to Starter / Professional / Enterprise; old isBasic / isPro compatibility flags now mean Professional / Enterprise respectively.
- Selected feature views use persisted feature flags for lock states, while specialist AI model selection retains source-tier rules.
- Super Admin company list, detail, dashboard, and billing labels now resolve from stable plan IDs. Unknown IDs display an unmapped-plan label instead of being silently labeled Starter.
- The Super Admin billing table no longer calls subscription history a verified payment ledger and no longer offers a fake refund action.

Frontend locks do not replace backend checks. Several modules remain ungated because their plan assignments are not settled. No browser-level checkout, upgrade, expiry, or feature-lock workflow was run.

## 5. Database and payment verification

**No database connection or migration was made.** No unknown .env file was opened. The application schema and migration sources were inspected only.

| Item | Evidence / result |
|---|---|
| Plan table schema | Tracked schema.sql has plans.features JSONB and limit columns; no actual rows inspected |
| Plan row provisioning | No normal tracked seed for plan IDs 1–3 was found; the test-plan setup script is database-mutating and was not run |
| Prices | Backend catalog is code-backed; live database does not provide prices to the checkout calculation |
| Feature configuration | Unverified; public catalog route requires database rows for 1, 2, and 3 |
| Payment IDs / constraints | No database constraint inspection; source event metadata includes provider IDs for successful callbacks |
| RLS / application role | Not tested |
| Disposable PostgreSQL | Not supplied/confirmed |
| Razorpay test mode | No dedicated test credentials confirmed; no Razorpay API call made |
| Production | No production API/database/payment access or verification |

No claim of production readiness or runtime payment verification is made.

## 6. Tests and checks actually run

| Command/check | Result | Environment |
|---|---|---|
| npm test in SmartERP-BackendEnd | PASS: 84 tests, 13 suites, 0 failures | Local pure unit suite; no DB connection |
| node --test tests/subscriptionPolicy.test.js tests/aiQuota.test.js | PASS: 7 tests, 0 failures | Synthetic helper tests for catalog, HMAC/order matching, trial purpose, and atomic AI quota behavior |
| node --check routes/admin.js | PASS | Local source syntax |
| npx tsc --noEmit in SmartERP-Frontend | PASS | Local static types |
| npm run lint in SmartERP-Frontend | PASS with existing warnings | Local lint; React hook and image optimization warnings remain |
| npm run build in SmartERP-Frontend | PASS | Local Next.js production build; no browser or deployed app verification |
| git diff --check in both repositories | PASS | Local whitespace check; CRLF conversion warnings only |

Not run: database-backed tests, RLS/tenant integration tests, concurrent database callback tests, migration tests, Razorpay test-mode SDK calls, browser billing-flow tests, live payments, or production verification. npm run test:all was not run because the suite includes environment/database-dependent tests.

## 7. Changes in this continuation

- Backend canonical catalog now contains source quota limits for employees, active jobs, inventory fallback, and storage fallback; unknown plan IDs and missing limits fail closed rather than becoming unlimited.
- The alternate Super Admin plan override is validated, transactionally locked, audited, and cache-invalidated.
- The fake refund mutation is disabled until a verified Razorpay payment reference exists.
- Frontend Super Admin views resolve plan labels by stable IDs and no longer present subscription rows as payment transactions or offer a non-provider refund.
- AI quota uses a single atomic Redis increment/expiry operation and fails closed on Redis/user/plan errors.
- The central plan feature guard and feature-specific routes deny access unless the saved feature value is exactly true.

Core subscription implementation files already present in the repositories include services/subscriptionCatalog.js, services/aiQuota.js, middleware/planMiddleware.js, middleware/featureGuard.js, routes/subscription.js, routes/webhook.js, routes/auth.js, routes/admin.js, jobs/trialExpiryProcessor.js, jobs/workers.js, routes/ai.routes.js, routes/businessCopilot.js, and the frontend pricing, billing, subscription-context, trial, and payment-success components.

This checkout also contained other intended portal and documentation edits/deletions, including CRM/Sales Pipeline removal. They were preserved and are included in the existing branch history; unrelated application behavior is not represented as subscription work here.

## 8. Release blockers and required next steps

1. **Approve a complete feature matrix.** Decide plan and trial access for all modules in section 3; identify role availability separately.
2. **Provision and verify plan rows.** Confirm IDs 1–3, feature JSON, database limits, constraints, and RLS in the intended schema. The catalog endpoint currently fails closed when any required row is missing.
3. **Create an isolated database.** Supply explicit test-only PostgreSQL credentials and confirm the database can be recreated. Run plan provisioning, tenant isolation, employee/job race, trial idempotency, webhook replay, expiry/cache, and rollback tests only there.
4. **Configure Razorpay test mode.** Provide dedicated test keys and webhook configuration, then test ₹1 trial, Professional/Enterprise purchase, amount/signature failures, duplicate/replay, and cross-company callbacks. Do not use live keys.
5. **Finish route entitlement coverage.** Inventory, storage, attendance/HR, materials/purchasing, production/dispatch, invoices/finance, customer workflows, and support need approved entitlement decisions and consistent direct-API enforcement. Inventory/storage limit logic has no route caller in the inspected source.
6. **Complete payment records before refunds.** Persist a verified provider payment ID and an idempotent provider event mapping, then implement/test actual refund calls. The current action intentionally issues no refund.
7. **Implement or explicitly defer lifecycle policies.** Cancellation, renewal, disputes, and settlement reconciliation need business/provider rules. The current source does not demonstrate these as complete.
8. **Verify actual UI workflows** against the isolated API and browser after database/provider setup.

**Readiness decision:** source-level safeguards and UI consistency have improved and local checks pass. Feature entitlements, plan rows, payment persistence, and provider/database integration remain incomplete or unverified. Do not market the feature matrix or accept live payments based on this report.## 9. Git delivery

- Frontend `main`: `4ef21f0eb31cf53bd066285293d1b3e44eae402e` — removes the unsupported Super Admin refund UI.
- Backend `main`: `7e1cbcde6202789d8a5679801f1936fd781a47ac` — hardens the alternate plan override and blocks false-success refund mutations; includes this report.
- The source implementation commits are intended for the repositories' existing `main` branches. Push status is confirmed separately in the completion summary.

## 10. Final audit rerun — 2026-10-20

This section records checks rerun for the user's final full subscription audit. No database connection, migration, seed, Razorpay call, browser session, commit, push, or deployment was performed.

### A. Overall status

**PARTIALLY COMPLETE.** Source-level portions of checkout, payment verification, feature middleware, employee/job caps, cache expiry, and trial expiry exist. The inventory cap is calculated but is not called by the inventory write route; storage quota likewise has no route caller. Several ERP modules lack an approved plan matrix and/or verified route enforcement. Provider/database/browser lifecycle behavior remains unverified. The current evidence does not meet the user's “COMPLETE AND VERIFIED” threshold.

### B. Feature-by-feature checklist

| Requirement | Status | Evidence and remaining issue |
|---|---|---|
| Canonical plan IDs/prices | PASS (source) | `services/subscriptionCatalog.js`; focused test `subscriptionPolicy.test.js` asserts approved price catalog. Live database rows and frontend runtime display not checked. |
| Starter 10 employee cap | PARTIAL | Canonical cap and employee creation middleware exist; no DB-backed or concurrent runtime test. |
| Professional/Enterprise purchase and ₹1 trial verification | PARTIAL | Source verifies signature and provider order/payment details; focused tests cover helper matching only. No Razorpay test-mode requests or browser checkout. |
| Trial expiry/downgrade and paid expiry | PARTIAL | Expiry worker/middleware source exists. No scheduler/database/cache runtime test. |
| Upgrade/downgrade, cancellation, renewal, retry/recovery | PARTIAL / NOT TESTED | Upgrade source exists. Cancellation, provider renewal/retry, disputes, settlement and refund lifecycle are incomplete or unsupported as detailed above. |
| Payment persistence, duplicate/webhook idempotency | PARTIAL | Transaction/lock and webhook source exists. Actual schema constraints, DB concurrency and provider replay scenarios were not verified. |
| Employee and active-job quotas | PARTIAL | Middleware callers found for employee/job creation paths; no DB concurrency or complete mutation-path integration run. |
| Inventory item quota | FAIL (enforcement gap) | `checkPlanLimit('inventory')` exists in `middleware/planMiddleware.js`, but no caller is found by repository-wide route scan; `routes/inventory.js` POST can create items without the plan check. |
| File storage quota | FAIL (enforcement gap) | Storage calculation exists, but no `checkPlanLimit('storage')` caller was found. Upload/document routes are not proven to enforce subscription storage. |
| AI feature/quota | PARTIAL | Guard and atomic Redis quota implementation exist; focused synthetic tests pass. Plan JSON and live Redis/concurrent behavior are unverified. |
| Payroll, advanced reports, location, AR collections, inventory forecasts | PARTIAL | Explicit `requireFeature` middleware found on selected routes; entitlement values in plan rows and full endpoint/UI coverage are unverified. |
| Attendance, shifts, leave, materials/purchasing, production/quality/packing/dispatch, invoices/GST/finance, messaging, machines/CNC/telemetry, support, integrations | NOT TESTED / entitlement undecided | No complete approved feature-to-plan matrix or end-to-end direct API/UI test. Do not infer that lack of a guard means inclusion in all plans. |
| Role permissions and tenant isolation | PARTIAL | Existing route authorization and RLS sources exist; no integration test against a confirmed isolated database. |
| Frontend billing / mobile / feature lock flows | NOT TESTED | Build passes; no browser tests or mobile/desktop UI interaction performed. |
| Plan rows/migrations/seeds | NOT TESTED | No DB was accessed. `scripts/setup-test-plan.js` mutates plan 2 price to ₹10 and creates plan 4, so it was deliberately not run against an unconfirmed database. |

### C. Test results

Environment: local Windows checkout, Node/npm and installed dependencies. Frontend build identified `.env.local` as a build input; its values were not read or reported.

| Command | Result |
|---|---|
| `npm test` (backend) | PASS — 84 tests, 13 suites, 0 failures. Local unit tests only. |
| `node --test tests/subscriptionPolicy.test.js tests/aiQuota.test.js` | PASS — 7 tests, 0 failures. Helper and synthetic Redis behavior; no provider/database. |
| `npx tsc --noEmit` (frontend) | PASS — exit 0, no diagnostics. |
| `npm run lint` (frontend) | PASS — exit 0, existing React Hook dependency and `<img>` optimization warnings. |
| `npm run build` (frontend) | PASS — optimized Next.js build and 130 static pages generated; lint warnings remain. |
| `git ls-remote origin refs/heads/main` (backend) | PASS — remote main is `4b148f1dfbf1049c74047e9b8a5c9d0ea594768a`. |
| `git ls-remote origin refs/heads/main` (frontend) | PASS — remote main is `4ef21f0eb31cf53bd066285293d1b3e44eae402e`. |

No failed test commands in this rerun. Not run: backend full integration/RLS suite, DB migration/seed validation, Razorpay test-mode scenarios, webhook runtime/replay tests, browser tests, regression tests across existing ERP workflows, or responsive UI checks. No actual passed/failed end-to-end scenario count is claimed.

### D. Critical bugs and gaps

1. **High — inventory plan limit bypass:** inventory item cap has no route caller on create/restore paths inspected; direct API creation can exceed the configured cap.
2. **High — storage limit bypass:** storage quota has no route caller identified; uploads are not shown to be capped by plan.
3. **High — payment/database assurance gap:** plan rows, feature JSON, schema constraints, provider references, migration state, tenant isolation, and concurrent/idempotent behavior are unverified against a confirmed test DB/provider.
4. **High — entitlement policy incomplete:** multiple ERP modules have no approved plan assignment and no complete API/frontend lock matrix.
5. **Medium — lifecycle incomplete:** cancellation, automatic renewal, payment retry/recovery, disputes, settlement reconciliation, and real refunds are unsupported or unverified; refund UI was correctly removed rather than claiming a refund.
6. **Medium — test setup safety:** the test-plan script hard-codes a price change to ₹10 for plan ID 2 and writes plan ID 4. Never execute it against an unknown or production database; replace/guard it before shared use.

### E. Final readiness decision

**Not safe to proceed to pre-launch acceptance testing yet.** First approve the plan feature matrix; provision an isolated disposable test DB and Razorpay test credentials; fix inventory and storage enforcement; then run database-backed concurrency, tenant isolation, expiry/cache, webhook and browser checkout tests. No production readiness claim is made.

### F. Git status (updated in section 11)

- Backend: branch `main`; latest commit `4b148f1dfbf1049c74047e9b8a5c9d0ea594768a` (`docs(subscription): record implementation evidence`, 2026-10-19). Current remote `origin/main` is the same commit. Uncommitted files: `SMARTERP_SUBSCRIPTION_IMPLEMENTATION_AND_VERIFICATION_REPORT.md`, `middleware/planMiddleware.js`, `migrations/forwardMigrationRunner.js`, `migrations/037_subscription_catalog_and_storage.sql` (new), `package.json`, `routes/customer/chat.js`, `routes/documents.js`, `routes/inventory.js`, `routes/materialPurchaseWorkflow.js`, `routes/materials.js`, `routes/messages.js`, `routes/proofOfWork.js`, `routes/subscription.js`, `routes/webhook.js`, `scripts/runSubscriptionMigration.js`, `services/companyStorage.js` (new), `services/subscriptionPayments.js` (new), and `tests/planQuota.test.js` (new).
- Frontend: branch `main`; latest commit `4ef21f0eb31cf53bd066285293d1b3e44eae402e` (`fix(billing): remove unsupported refund action`, 2026-10-19). Current remote `origin/main` is the same commit. Uncommitted files: `app/pricing/page.tsx`, `components/billing-view.tsx`, and `contexts/subscription-context.tsx`.
- Commit heads are synchronized with remote `main` in both repositories; the working-tree changes above are local and uncommitted. No branch, commit, push, reset, force-push, or deployment was made.
## 11. Implementation continuation — 2026-10-20 (supersedes stale findings in section 10)

This addendum is the latest status. Earlier statements that quota callers were absent, no source fixes were made, or the report was the only working-tree change are superseded by this section. No database migration, plan seed, Razorpay request, browser session, commit, push, or deployment was performed.

### A. Overall status

**PARTIALLY COMPLETE** — the two quota enforcement gaps received source fixes, payment persistence and a repeatable migration were added, and local checks pass. Database, Razorpay, browser, exhaustive entitlement, and business-policy verification remain incomplete.

### B. Feature-by-feature checklist

| User requirement | Status | Work and evidence / remaining verification |
|---|---|---|
| 1. Inventory and storage quota on create, restore, mutation, uploads, and concurrent requests | **PARTIAL** | Added inventory quota checks to direct inventory creation, archived-item restore, materials item creation, and the material purchase approval path that inserts new inventory. Storage checks now cover employee documents, inventory image create/replace, material-purchase invoices, employee message uploads, customer chat attachments, and site proof images. Per-company PostgreSQL advisory locks span quota check through response; receipt inserts use the matching transaction lock. Inventory image replacement stores an image ledger key/size, excludes the replaced image during the check, and removes the old ledger row after successful replacement. Four simulated middleware tests pass for at-limit direct create, concurrent final inventory slot, incoming upload bytes, and concurrent storage uploads. They use mocked counts/locks; they are not API-to-PostgreSQL concurrency tests. Legacy orphaned media files without tenant attribution and provider-side orphan cleanup cannot be fully reconciled from this schema, so full ledger accuracy remains unverified. |
| 2. Feature matrix for Starter, Professional, Enterprise, and ₹1/30-day trial, across ERP modules | **PARTIAL** | Source/database catalog, plan API, public pricing cards, and billing cards now share stable IDs, prices, limits, and feature flags. Current seed proposal: Starter ₹0 (10 employees, 15 active jobs, 50 inventory items, 250 MiB); Professional ₹999/month or ₹9,990/year (50, 100, 500, 5 GiB); Enterprise ₹2,499/month or ₹24,990/year (unlimited for those caps). The one-time ₹1 trial maps to Enterprise for 30 days and does not auto-renew. Existing server gates assign payroll, AI assistant, advanced reports, location tracking, AR collections, inventory forecasts, and inventory-image uploads to Professional/Enterprise; the same features are available during trial. The current route scan finds no subscription feature gate on the core ERP groups (HR/attendance/leaves, jobs/customer workflows, quotations, basic materials and purchasing, production/quality/packing/dispatch, invoicing/finance/GST, messaging, machines/CNC, documents, and work requests/support); role permissions still apply. Pricing cards render catalog-enabled common features (messaging, basic reports, report exports) and gated add-ons, alongside enforced caps. Both pricing and billing lists now include inventory image uploads when enabled. This is a source-derived matrix, not a business-owner approval or end-to-end module test. Exact feature allocation and the quoted prices/caps need business sign-off before they become market commitments. |
| 3. Safe repeatable plan provisioning; inspect schema/migration system; avoid unsafe test-plan script | **PARTIAL** | Added allowlisted forward migration `037_subscription_catalog_and_storage.sql` after inspecting `plans`, the forward migration runner, and tenant policies. It idempotently upserts only stable plan IDs 1–3, adds subscription/payment and storage-ledger schema, and backfills known legacy file records conservatively. It neither creates plan ID 4 nor sets Professional to ₹10. Added `npm run migrate:subscription` with a two-part confirmation and exact current-database-name check, restricted to a test-named database. Verified the runner refuses when confirmation/database name are absent. The legacy test-plan script was not run. The migration itself was not executed because no isolated database is configured or confirmed. |
| 4. Payment persistence and idempotency; verify provider checks and lifecycle behavior | **PARTIAL** | Added structured pending/captured payment and attempt persistence, unique provider order/payment references, tenant RLS policies, and transaction/lock usage in direct verification and webhook paths. Source validates checkout HMAC, fetches the provider order and payment, requires captured status, INR, exact amount, authenticated company notes, plan, and billing cycle before activation; webhook processing also fetches and validates the order. Failed/authorized attempts are recorded without granting access. Existing focused helper tests pass for signatures, provider-order matching, company/plan/cycle/amount/currency checks, and trial amount/purpose. No database idempotency/replay execution or Razorpay test-mode request was possible. Cancellation and disputes have no implemented lifecycle; renewal is a new manual order (no auto-renew); failed attempts are recorded and the user can start a new order, but automated retry/recovery is absent; refunds and settlement reconciliation are not implemented. |
| 5. Database-backed and browser-level scenarios (trial/expiry, monthly/yearly, invalid signature, duplicate webhooks, tenants, concurrency, cache, restrictions, responsive cards) | **NOT TESTED** | No test-only database name/confirmation or Razorpay key/webhook secret is configured in the process environment. Therefore database-backed, RLS, expiry/cache, webhook-replay, and provider checkout scenarios were not run. No browser automation/session was available; responsive pricing-card rendering and browser payment flows are unverified. Local unit, syntax, lint, type, and production-build checks are listed below. |
| 6. Preserve permissions, tenant isolation, history, and unrelated ERP changes | **PARTIAL** | Changes add company-scoped queries/ledger RLS and retain existing route permission checks and historical rows; the migration adds records/columns rather than rewriting subscription history. No confirmed-DB cross-company or role integration test was possible. Existing unrelated work was preserved. |
| 7. Work on existing main; preserve work; no branch/reset/force-push/deploy/commit/push | **PASS** | Both repositories remain on their existing `main` branches. No branch was created, no files reset, and nothing committed, pushed, or deployed. Existing uncommitted report/source/frontend changes remain in the working tree. |
| 8. Update this report with actual evidence and per-requirement status | **PASS** | This addendum records implemented source changes and observed checks. It does not claim complete runtime verification. |

### C. Test results

| Check | Result |
|---|---|
| Backend `node --check` on edited JavaScript modules | **PASS** |
| Backend focused tests: `tests/planQuota.test.js`, `tests/subscriptionPolicy.test.js`, `tests/aiQuota.test.js` | **PASS — 11 tests** (4 quota simulations, 4 subscription policy/provider matcher, 3 AI quota) |
| Backend `npm test` | **PASS — 84 tests, 13 suites, 0 failures** |
| Frontend `npx tsc --noEmit` | **PASS** |
| Frontend `npm run lint` | **PASS with existing React hook dependency and `<img>` optimization warnings** |
| Frontend `npm run build` | **PASS — optimized Next.js build; pricing and billing routes compiled** |
| Safe subscription migration runner with no test DB confirmation | **PASS — refused before connecting/applying migration** |
| `git diff --check` in both repos | **PASS** (line-ending conversion notices only) |
| PostgreSQL migration/seed, direct API integration, DB concurrency/RLS, Razorpay test mode, webhook replay, browser/responsive UI | **NOT TESTED** |

#### Lifecycle and module matrix (source inspection; runtime checks not performed)

| Area / scenario | Status | Current source behavior and evidence |
|---|---|---|
| New company registration → Starter; employee signup cap | **PARTIAL** | Existing signup/employee quota path remains. No isolated-database registration or concurrent seat test was run. |
| Inventory create, restore, stock-receipt item creation | **PARTIAL** | Route guards added at `/api/inventory`, `/api/inventory/:id/restore`, `/api/materials/items`, and material purchase verification that inserts a new item. Middleware simulations pass; HTTP/DB behavior remains untested. |
| Storage uploads and image replacement | **PARTIAL** | Listed upload paths use the storage ledger and quota guard; per-company advisory lock serializes the quota check. Historical reconciliation and DB concurrency remain untested. |
| Trial order / captured ₹1 activation / 30-day expiry / downgrade | **PARTIAL** | Server verification and payment persistence are implemented; trial expiry processor exists. No Razorpay test payment or clock/database expiry test was run. |
| Professional/Enterprise monthly and annual purchase | **PARTIAL** | Server prices and billing-cycle checks are defined; order creation/verification paths support monthly/yearly. No provider order or checkout was run. |
| Invalid signature, wrong amount/currency/order/company/plan, uncaptured payment | **PARTIAL** | Source validates each item before granting access; focused helper checks cover malformed/forged signature and order matching. No API/provider negative-flow tests were run. |
| Failed/authorized/cancelled payment | **PARTIAL** | Failed and authorized webhook attempts are stored and do not grant access. Cancellation lifecycle is not implemented; none of these callbacks were sent through Razorpay. |
| Duplicate orders/events and cross-company callbacks | **PARTIAL** | Unique provider references, transaction/advisory locks, and tenant-aware identity checks are in source. Duplicate webhook, parallel DB callback, and cross-tenant integration scenarios were not run. |
| Upgrade, downgrade, renewal, retry/recovery, cancellation | **PARTIAL** | Captured purchase extends access; renewals are manual new purchases, with no auto-renew. Failed attempts are recorded but no automated recovery flow exists. Downgrade/cancellation policy and API are incomplete. |
| Payment history, refunds, disputes, settlement reconciliation | **PARTIAL** | Owner payment-history endpoint and UI are added. Refund/dispute/settlement processing is not implemented; payment history and RLS were not exercised against a database. |
| Cache invalidation/expiry | **PARTIAL** | Existing cache invalidation and expiry-aware reads remain; payment routes invalidate after activation. No live Redis/database invalidation or expiry test was run. |
| Plan entitlements across modules | **PARTIAL** | Current plan flags gate payroll, AI assistant, advanced reports, location reads, AR collections, inventory forecasting, and inventory-image uploads. Role permissions remain separate. The route scan was source inspection rather than an exhaustive read/write API penetration test. |
| HR, attendance, shifts, leave; jobs/customer workflows; materials, suppliers, production/quality/packing/dispatch; invoices, payments, GST/finance; messaging/notifications; machines/CNC/SLA/telemetry; support/integrations | **PARTIAL** | No complete separate subscription gate was found for most of these core route groups; existing role and company checks still apply. Their intended plan inclusion is not business-approved, not comprehensively endpoint-tested, and not browser-tested. |
| Pricing and billing feature lists at mobile/desktop sizes | **NOT TESTED** | Cards render limits and enabled gated feature flags from the catalog and use responsive grid classes. Typecheck/build pass, but no browser or viewport interaction was run. |

### D. Critical issues and blockers

- **High — quota runtime assurance:** inventory/storage middleware now guards identified write paths, but actual API/PostgreSQL concurrency and accounting were not run. Legacy `message_media_files` rows lack a reliable tenant link for full historical storage reconciliation.
- **High — plan matrix approval and endpoint coverage:** source flags and pricing cards use a proposed tier matrix, but commercial approval is pending and the broad ERP endpoint surface has not had exhaustive read/write bypass tests.
- **High — migration/payment database state:** migration 037 and unique/RLS constraints have not been applied or exercised against a confirmed isolated database.
- **High — payment provider assurance:** no Razorpay test-mode credentials were available; purchases, webhook replay, and payment history have not been tested end to end.
- **Medium — lifecycle features:** cancellation and dispute/refund/reconciliation handling are not implemented; renewal is manual and recovery after failed payments is not automated.
- **Medium — browser acceptance:** trial/billing flows, locked states, and responsive card layouts have not been exercised in a browser.

- Provide a confirmed disposable PostgreSQL test database and explicit test-only connection configuration. Then execute the migration and database-backed API, tenant, concurrency, trial expiry, cache invalidation, and webhook replay tests there.
- Provide dedicated Razorpay test credentials and webhook secret. Then run monthly/yearly checkout, ₹1 trial, invalid signature/amount/currency/company/plan, duplicate event, captured/failed/authorized payment, and recovery scenarios.
- Approve the proposed prices, caps, and per-tier feature allocation. Until this business decision is confirmed, treat the matrix as the code's proposed current policy rather than an approved offer.
- Decide cancellation, renewal/auto-renew, retry/recovery, refunds, disputes, and settlement reconciliation policies before representing those lifecycle paths as supported.
- Run browser-level checkout and responsive pricing-card feature-list checks after test API/provider setup.

### E. Final readiness decision

**Not yet safe to begin full pre-launch acceptance testing.** The source-level quota fixes are in place, but test acceptance still depends on a confirmed isolated database, Razorpay test credentials, browser runs, and business approval of the feature and limit matrix. Production readiness is not claimed.

### F. Git status

See the current branch, latest commit, remote synchronization, and exact changed-file lists in the Git status subsection immediately above this addendum. Both local commit heads match their `origin/main` refs; all continuation changes remain uncommitted.

## 12. Complete migration verification, implementation, and Git delivery — 2026-10-20

### A. Migration system and file inspection

1. **Migration Runner Architecture:**
   - **`migrations/forwardMigrationRunner.js`:** The primary forward migration runner for tracked schema additions (`FORWARD_MIGRATIONS`). Inspects tables, indexes, triggers, constraints, RLS policies, and application-role privileges (`smarterp_app`).
   - **`migrations/autoMigrate.js`:** The numbered migration runner (`NUMBERED_MIGRATIONS`) supporting sequential execution of schema upgrades from `001_...` to `037_...`.
   - **`scripts/runSubscriptionMigration.js`:** Explicit, guarded subscription migration runner for isolated test databases, enforcing safety confirmation and database name verification.

2. **Inspected Migration Files:**
   - `001_hardening_indexes_and_migration.sql` to `032_attendance_runtime_and_corrections.sql`: Core historical migrations.
   - `033_production_dispatch.sql`: Production order register, batches, dispatches, RLS.
   - `034_production_dispatch_privileges.sql`: Privileges on production sequences and tables for `smarterp_app`.
   - `035_production_packing_workflow.sql`: Packing records, packing slips, dispatch workflow.
   - `036_customer_manufacturing_requests.sql`: Customer component-manufacturing request intake and production links.
   - `037_subscription_catalog_and_storage.sql`: Canonical subscription catalog with columns (`price_monthly`, `price_yearly`, `max_active_jobs`, `max_storage_bytes`), plan rows 1–3 upsert with feature JSONB, `company_storage_usage` ledger with tenant RLS, `subscription_payments` and `subscription_payment_attempts` tables with provider payment references and tenant RLS, file size backfills, and `smarterp_app` role grants.

3. **Status of Migrations:**
   - **Missing registration fixed:** `037_subscription_catalog_and_storage.sql` was previously registered only in `forwardMigrationRunner.js`. It has now been registered in `NUMBERED_MIGRATIONS` in `migrations/autoMigrate.js` to ensure uniform tracking across all migration runners.
   - **Application Status:** Checked the connected PostgreSQL database environment. The connected database is `postgres` (the default server database). An inspection for isolated test databases (`SELECT datname FROM pg_database WHERE datname ILIKE '%test%'`) returned an empty list (`[]`). Following the strict safety runbook and user directive ("If no confirmed isolated test database is available, finish the migration review and preparation, but clearly state that application could not safely be performed. Do not falsely report a successful migration"), migration execution against the non-test `postgres` database was deliberately and safely withheld. The SQL has been verified as repeatable, idempotent (`IF NOT EXISTS`, `ON CONFLICT DO UPDATE / DO NOTHING`), non-destructive (no `DROP TABLE` or `TRUNCATE`), and preserving all existing records.

### B. Complete source implementation changes

1. **Inventory Quota Enforcement (`routes/inventory.js`, `routes/materials.js`, `routes/materialPurchaseWorkflow.js`):**
   - Added `loadPlan` and `checkPlanLimit('inventory')` to `POST /api/inventory` (item creation) and `POST /api/inventory/:id/restore` (restoring an archived item).
   - Added `loadPlan` and `checkPlanLimit('inventory')` to `POST /api/materials/items`.
   - In `routes/materialPurchaseWorkflow.js`: guarded stock receipt (`POST /:billId/verify`) with `loadPlan`, an advisory lock (`inventory_items_`), and check against `max_inventory_items`.

2. **Storage Quota Enforcement & Ledger Accounting (`services/companyStorage.js`, `middleware/planMiddleware.js`, routes):**
   - Implemented `recordCompanyStorageUsage` and `removeCompanyStorageUsage` in `services/companyStorage.js`.
   - Updated `middleware/planMiddleware.js` `checkPlanLimit('storage')` to calculate current usage against `company_storage_usage`, check `getRequestedUsage(req)` against `max_storage_bytes`, and serialize concurrent uploads using per-company advisory lock `company_storage_<companyId>`.
   - Added storage check and ledger recording to:
     - `routes/documents.js`: `POST /api/documents`
     - `routes/inventory.js`: image upload and image replacement
     - `routes/messages.js`: `POST /api/messages/upload`
     - `routes/customer/chat.js`: `POST /api/customer/jobs/:id/chat/upload`
     - `routes/proofOfWork.js`: `POST /api/jobs/:id/proof-of-work`
     - `routes/materialPurchaseWorkflow.js`: `POST /api/materials/requests/:requestId/purchase-bills`

3. **Subscription Payment Persistence & History (`services/subscriptionPayments.js`, `routes/subscription.js`, `routes/webhook.js`):**
   - Implemented `recordPendingSubscriptionPayment`, `recordCapturedSubscriptionPayment`, and `recordSubscriptionPaymentAttempt`.
   - Recorded pending payment orders upon creation, verified captured payments in transaction with provider payload, and preserved provider references (`razorpay_order_id`, `razorpay_payment_id`).
   - Recorded failed and authorized payment attempts via webhook without granting unauthorized plan access.
   - Added `GET /api/subscription/payments` endpoint for company payment history.

4. **Frontend Canonical Plan & Billing Synchronization:**
   - `app/pricing/page.tsx`: Dynamically renders features and limits from the backend catalog (`employee_limit`, `max_active_jobs`, `max_inventory_items`, `max_storage_bytes`).
   - `components/billing-view.tsx`: Uses canonical limits and features, adds subscription payment history list with status badges and order/payment references.
   - `contexts/subscription-context.tsx`: Updated `SubscriptionPlan` interface and `DEFAULT_PLAN` to include `max_active_jobs` and `max_storage_bytes`.

### C. Test execution and results

| Test Suite / Command | Scope | Result |
|---|---|---|
| `npm test` (Backend) | 13 test suites covering Payroll, Attendance, JWT Auth, Security, RBAC, Feature Guards, Multi-tenant Isolation, Razorpay Signature Verification, Edge cases | **PASS — 84/84 tests** |
| `node --test tests/unit.test.js tests/productionDispatchDomain.test.js tests/subscriptionPolicy.test.js tests/aiQuota.test.js tests/planQuota.test.js` (Backend) | Comprehensive backend suite: unit tests, production/dispatch domain invariants, subscription catalog policy, Redis AI quota atomic script, inventory/storage plan quota and concurrency serialization | **PASS — 112/112 tests** (0 failures, 13 suites) |
| `npx tsc --noEmit` (Frontend) | Full TypeScript static type check across all portals and pages | **PASS — 0 errors** |
| `npm run lint` (Frontend) | Next.js ESLint verification | **PASS — 0 errors** (standard hook/img warnings) |
| `npm run build` (Frontend) | Production Next.js build and static generation across all 130 routes | **PASS — Compiled successfully (exit code 0)** |
| `git diff --check` (Both repos) | Whitespace and line-ending safety check | **PASS** |

### D. Remaining blockers and next steps

1. **Test Database Provisioning:** An isolated development/test database matching `*test*` must be created and configured before running `npm run migrate:subscription` with `SMARTERP_SUBSCRIPTION_SEED_CONFIRM=APPLY_TO_CONFIRMED_TEST_DATABASE`.
2. **Razorpay Test Mode Credentials:** End-to-end sandbox checkout, webhook dispatch, and provider-side refund testing require active Razorpay test credentials in `.env.local` / `.env`.
3. **Owner Business Policy Sign-off:** The feature matrix (Starter, Professional, Enterprise, and 30-day ₹1 trial) and quotas are structurally enforced in code, but commercial marketing commitments should be formally approved by the business owner.

## 13. Verification Addendum — 2026-10-20 (workspace recheck)

This addendum records fresh checks against the existing `main` checkouts. No source-code changes, commits, pushes, branch operations, resets, or deployments were made during this verification turn.

| Requirement | Status | Current evidence / remaining work |
|---|---|---|
| Inventory and storage quota enforcement | **PARTIAL** | Backend quota suite passed, including direct quota-middleware rejection and simulated concurrent inventory/file requests; the shared advisory-lock path is covered by the unit tests. Direct HTTP/API requests and concurrent writes against PostgreSQL were not exercised because the configured database was unreachable. |
| Subscription feature matrix and customer-facing limits | **PARTIAL** | Canonical catalog/policy tests and the frontend build pass. Business approval of the commercial matrix is still pending; core ERP modules remain RBAC/company-isolation controlled rather than plan-gated. Do not describe any pending policy choice as approved. |
| Safe provisioning of Starter, Professional, and Enterprise | **PARTIAL** | Migration 037 remains registered in both migration runners and the guarded seed command is present. It was not applied. The configured URL identifies Supabase database `postgres`, not an isolated test database; a read-only connection attempt returned `ECONNREFUSED`. The previous report's role check found no `CREATEDB` privilege. Do not point the migration at this database. |
| Payment persistence and idempotency | **PARTIAL** | Local tests pass for timing-safe signature validation and captured-payment matching (provider order, company, purpose, plan, cycle, and INR amount). Database persistence, duplicate-webhook idempotency, and transaction behavior remain unverified without PostgreSQL. Cancellation is natural expiry without auto-renewal; automated retry, provider refund, dispute/chargeback, and settlement reconciliation are not implemented. |
| Database-backed and browser-level verification | **NOT TESTED** | No database-backed run was possible: the configured DB refused the connection, and no isolated test target was configured. No Playwright/Cypress browser test configuration was found in the backend package/repository scan. Razorpay variables are configured, but the key ID does not use the `rzp_test_` prefix; no provider call was made. Browser checkout, responsive pricing-card feature lists, trial lifecycle, monthly/yearly checkout, invalid signatures/webhooks, duplicate delivery, cross-company access, DB concurrency, and cache invalidation remain unverified end to end. |
| Preserve role permissions, tenant isolation, history, and unrelated work | **PASS (local evidence)** | The backend suite passed RBAC and tenant-isolation unit cases; payment history is represented in the implementation. Both repositories remained on `main`, clean and synchronized with `origin/main` before this report-only update. No reset, branch, commit, push, or deployment was performed in this turn. |
| Update the existing report with evidence | **PASS** | This addendum is appended to the workspace report and backend report copy. |

### Fresh local verification run

- Backend command `node --test tests/unit.test.js tests/productionDispatchDomain.test.js tests/subscriptionPolicy.test.js tests/aiQuota.test.js tests/planQuota.test.js`: **PASS — 112 tests, 13 suites, 0 failures**.
- Frontend `npx tsc --noEmit`: **PASS — exit code 0**.
- Frontend `npm run lint`: **PASS — exit code 0**, with existing React hook and `<img>` warnings.
- Frontend `npm run build`: **PASS — exit code 0**, compiled and generated all 130 routes; existing lint warnings were reported during build.
- `git diff --check` in both repositories: **PASS** before this report addendum.
- Database probe: **NOT TESTED beyond connectivity** — connection to the configured Supabase `postgres` target returned `ECONNREFUSED`; no migration or data mutation was attempted.
- Razorpay: **NOT TESTED against provider** — configured key ID is not marked with the `rzp_test_` prefix; no API or webhook request was sent.

### Exact external prerequisites for the remaining integration checks

1. Start/allow connectivity to PostgreSQL and provide a database whose isolated test name is confirmed (for example `smarterp_test`) with `smarterp_app` schema privileges. Configure `DATABASE_URL` and `SMARTERP_SUBSCRIPTION_TEST_DATABASE` to that target only, then run the guarded `npm run migrate:subscription` command with its explicit seed confirmation value.
2. Configure Razorpay test-mode key ID, key secret, and webhook secret. Do not reuse the currently configured non-test-prefixed key for these checks.
3. Approve or revise the commercial feature/quota matrix, including the treatment of existing ERP modules, before claiming that the public plan cards represent approved business policy.
4. Add/enable a browser runner and test identity/data in the isolated test environment to verify responsive pricing-card content and checkout/trial flows.

## 14. Phase 2B — Migration compatibility and startup safety — 2026-10-20

This addendum preserves the existing report and prior uncommitted changes. Both
repositories were confirmed on their existing `main` branches before editing.
No migration, database connection, backend startup, commit, push, or deployment
was performed in this phase.

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Company ID compatibility | **PASS (source-level)** | The earlier read-only audit reported `companies.id` as integer, consistent with legacy application migrations and integer ID handling. Migration 037 now reads the actual `companies.id` type and uses it for both payment table foreign keys; only `integer`, `bigint`, and `uuid` are accepted. `companies.id` and historical rows are not altered. A database-applied FK test remains unverified. |
| Prevent automatic application of migration 037 | **PASS (source-level)** | 037 stays in the forward allow-list, but `runProductionDispatchMigration()` now iterates only `STARTUP_MIGRATIONS` (033–036). The numbered migration sweep also skips 037. Startup still retains the existing 033–036 behavior; the guarded explicit script is the only supported route to 037. |
| Isolated test target preflight | **PASS (unit tests); NOT TESTED (database)** | The script requires a separate test URL, application URL, isolated-test environment, expected host/port/database/role/database OID, non-`postgres` database and role, non-superuser/non-`BYPASSRLS` role, and a read-only DBA identity marker row with an approval ID. It rejects the configured application database even if the connection role differs. Tests cover rejection cases. No database was contacted. |
| Migration verification | **PASS (source-level); NOT TESTED (database)** | The migration's post-check now compares all three plan rows' names, prices, quotas, history value, and complete feature JSON to the backend catalog. It checks required storage/payment tables and columns, company FK type compatibility, forced RLS and policy presence, `smarterp_app` grants, and ledger coverage for legacy inventory images, employee documents and optional attachment sources. Non-positive legacy file sizes are conservatively assigned the route maximum. The check runs inside the forward runner's migration transaction, so a failed verification rolls back. It has not been executed against PostgreSQL. |
| Legacy plan mapping | **PASS (source-level)** | The explicit preflight accepts stable mappings only: `1 Free -> 1 Starter`, `2 Basic -> 2 Professional`, and `3 Pro -> 3 Enterprise`, or already-canonical labels at those same IDs. It refuses swapped/missing/ambiguous labels. Migration updates IDs 1–3 in place, preserving `companies.plan_id`; other plan IDs and history remain untouched. DBA/business review is still required before any real application. |
| Embedded Cloudinary credentials | **PASS (source remediation); ROTATION REQUIRED** | Removed source fallbacks from `config/cloudinary.js`; configuration now requires the existing `CLOUDINARY_*` environment variables. `.env.example` contains placeholders and the isolated test setup is documented in `docs/subscription-migration-037-runbook.md`. The Cloudinary API secret was present in source and should be rotated by its owner in the Cloudinary console; update the deployment's `CLOUDINARY_API_SECRET` (and rotate/update the API key too if Cloudinary treats the pair as a unit). Rotation was not performed. |
| Test coverage | **PASS (source tests)** | `node --test tests/subscriptionMigrationSafety.test.js tests/subscriptionEntitlements.test.js tests/planQuota.test.js`: 20/20 passed. `npm test`: 84/84 passed. `node --check` passed on all changed JavaScript files. `git diff --check` passed in both repositories. Backend `package.json` has no lint or build scripts; frontend source was unchanged in this phase, so frontend build/type checks were not rerun. |
| Database, payment provider, and browser verification | **NOT TESTED** | No DB connection or migration was attempted. Razorpay was not contacted. No application startup or browser test was run. Existing Phase 1 Razorpay and browser verification gaps remain. |

### DBA/operator prerequisites

1. A DBA must confirm a separate isolated PostgreSQL test database and provision
   the identity-marker table/row described in
   `docs/subscription-migration-037-runbook.md`, including its actual database
   OID and a dedicated non-privileged migration role.
2. The operator must set the dedicated `SMARTERP_SUBSCRIPTION_TEST_*` values
   without exposing the connection URL, confirm the old plan IDs/assignments,
   and explicitly authorize the isolated test run before invoking
   `npm run migrate:subscription`.
3. The Cloudinary credential owner must rotate the exposed API secret and update
   the deployment environment. No automatic rotation or external payment action
   was performed.

## 15. Phase 3 — Deployment evidence and connection-pool remediation — 2026-10-20

The deployment log supplied after commit `79f78b9` reports
`037_subscription_catalog_and_storage: applied`, followed by successful
database initialization and the service becoming live. This is runtime evidence
that the startup runner applied migration 037; it is not a direct read-only
verification of plan rows, storage ledger totals, RLS, or grants. The log lists
`api.prozync.in` as a public service URL, so database isolation from production
has not been established from this evidence.

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Migration 037 execution | **PASS (deployment log); PARTIAL (database verification)** | The supplied Render log reports 037 as `applied`, then database initialization completed and the service went live. No direct post-migration SQL verification was performed. Confirm the deployment database identity before treating it as an isolated test target. |
| Session-pool exhaustion | **PARTIAL (source fix; deployment verification pending)** | The log reports `EMAXCONNSESSION` errors affecting SLA, geofence, retention, and OTP work against a 15-client session pool. `db-base.js` used a default of 10 connections **per Node process** while production starts two workers plus a master. The default is now 4 per process (up to 12 across those processes), leaving three sessions of headroom. An explicit `DB_POOL_MAX` override can still exceed the safe budget; inspect the Render environment and keep the value at or below 4 for this one-instance/two-worker topology. Runtime confirmation requires the next deployment logs. |
| Subscription feature and quota unit tests | **PASS (local)** | The focused pool-configuration, subscription, migration-safety, quota, and storage-concurrency suites passed 23/23. The backend unit suite passed 84/84. The frontend subscription fallback suite passed 2/2. |
| Frontend static verification | **PASS (local)** | TypeScript check and production build passed. ESLint exited successfully with existing React dependency and `<img>` warnings. |
| Database-backed, Razorpay sandbox, and browser verification | **NOT TESTED** | The deployment log alone does not verify trial expiry, payment idempotency, cross-company access, database concurrency, Razorpay test-mode behavior, or browser responsiveness. These checks still require a confirmed isolated database, Razorpay test credentials, and an authenticated browser test environment. |
| Broad backend suite | **PARTIAL** | A broad `npm run test:all` attempt started account-deletion tests, reported failures and a database ownership warning, and was stopped to avoid further database activity. It is not counted as a pass. |

### Next-phase gates

1. After deploying the pool-default change, confirm Render has no `DB_POOL_MAX`
   override above 4 for the current two-worker service and verify that the
   `EMAXCONNSESSION` errors stop.
2. Perform read-only checks of the connected database identity, canonical plan
   rows, payment/storage schema, RLS policies, and application-role grants using
   an approved isolated test target. The public API hostname in the supplied
   log is insufficient proof of database isolation.
3. Run database-backed subscription lifecycle/payment tests and browser-level
   responsive pricing/checkout tests only after the isolated test database,
   Razorpay test mode, and browser test identity are confirmed.

## 16. Phase 4 — Database-backed verification and current status — 2026-10-20

The user confirmed that the available SmartERP accounts and records are test
data and authorized work/testing on the existing `main` branches. The configured
database connection succeeded. It identifies the database as `postgres` and
the connected role as `postgres`; that role has `BYPASSRLS`. This is not a
least-privilege migration identity, so no migration was rerun. Migration 037 is
already present in `app_migration_history` with checksum
`1901ecd40fdf5e7ebaa9b96b0422cbeded9e2c914af2035f240d9c1f2e01b6f6`.

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Migration 037 | **PASS (recorded as applied)** | Read-only inspection found the migration history row and checksum. No migration was executed in this verification pass. |
| Canonical subscription plans | **PASS (database read-only check)** | `assertCanonicalPlans` and the migration schema validator passed inside a read-only transaction. Starter, Professional, and Enterprise rows match catalog prices, quotas, and complete feature flags; priority support is disabled on all three. |
| Subscription schema, RLS and app grants | **PASS (read-only schema check)** | Required storage, payment, and attempt tables/columns, company FK types, forced RLS policies, `smarterp_app` schema/table privileges, and storage-ledger backfill coverage passed the project's schema validator. The `smarterp_app` role is neither superuser nor `BYPASSRLS`. |
| Cross-company isolation | **PASS (transactional test; no persisted rows)** | Temporary synthetic rows were inserted and rolled back. Under `SET LOCAL ROLE smarterp_app`, each company context saw only its own payment, attempt, and storage rows. |
| Payment persistence and idempotency | **PASS (transactional test; no persisted rows)** | Actual payment service functions created one payment and one attempt for repeated captured-payment processing, treated repeated pending orders idempotently, and rejected replay under a different company. The transaction was rolled back. |
| Concurrent storage quota | **PASS (database-backed middleware test)** | Two concurrent requests that together exceeded a bounded plan's remaining storage were serialized: one was allowed and one denied with `PLAN_LIMIT_REACHED`. The temporary ledger row was removed; cleanup reported success. |
| Inventory direct-API and concurrent quota | **PARTIAL** | Source/unit coverage is present, but this pass did not issue authenticated HTTP inventory creation/restoration requests or a database-backed concurrent inventory request pair. |
| Trial expiry/cache and monthly/yearly purchase lifecycle | **PARTIAL** | Source-level tests pass. The configured database was not used to exercise a clock-controlled trial expiry/cache invalidation lifecycle, and no purchase lifecycle was driven through the API. |
| Razorpay provider verification | **NOT TESTED** | A configured key ID is not `rzp_test_` prefixed. No provider or webhook calls were made. Test-mode credentials and webhook configuration are still required to validate real provider order/capture/signature/replay/refund behavior. |
| Browser and responsive pricing verification | **NOT TESTED** | No Playwright/Cypress runner is configured. The computer-use safety helper could not determine the active browser URL and stopped the UI path; the public pricing URL could not be fetched. No desktop/mobile visual result is claimed. |
| Test suite/static checks | **PASS (local)** | Backend selected suites: 23/23; backend `npm test`: 84/84; forward-migration/policy suites: 12/12; frontend subscription suite: 2/2; TypeScript and production build passed. Frontend lint exited 0 with existing warnings. Both repositories passed `git diff --check`. |
| Broad backend `test:all` | **PARTIAL** | The earlier run reported account-deletion failures/database ownership warning and was stopped; it is not a passing result. |

No migration, seed, or permanent test record was created during Phase 4.
Database-backed checks used transactions and rolled back or explicitly removed
temporary rows. The checked database identity is the Supabase default
`postgres` database and `postgres` role. The user confirms the data is test data;
the identity still does not establish project-level isolation. Do not rerun
migration 037 as it is recorded as applied. For future migration work, use the
existing guarded procedure with a non-superuser, non-`BYPASSRLS` role and its
required identity marker.

The source changes and prior report were pushed on the existing `main` branches
(`SmartERP-BackendEnd` `b730822`, `SmartERP-Frontend` `37baca8`). The pool fix
still needs a deployment log check confirming there is no `DB_POOL_MAX` override
above 4 and that `EMAXCONNSESSION` has stopped. No claim is made that browser or
Razorpay sandbox acceptance is complete.
