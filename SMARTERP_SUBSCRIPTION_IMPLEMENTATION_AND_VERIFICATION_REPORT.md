# SmartERP Subscription Implementation and Verification Report

**Updated:** 2026-10-19
**Scope:** Subscription source implementation, feature-entitlement review, local verification, and Git delivery.
**Readiness:** Source safeguards are improved, but the subscription system is **not production-ready** until the listed database, feature-policy, and payment-provider blockers are resolved.

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

**Readiness decision:** source-level safeguards and UI consistency have improved and local checks pass. Feature entitlements, plan rows, payment persistence, and provider/database integration remain incomplete or unverified. Do not market the feature matrix or accept live payments based on this report.
