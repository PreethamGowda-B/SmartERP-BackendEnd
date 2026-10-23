# SmartERP AI RLS migrations 044–046 manual guide

## Status and order

This is a runbook, not evidence that any migration was executed. Migration 044 is present in the controlled forward-migration allowlist, but is excluded from startup execution; migration 045 is manual-only and migration 046 is not registered. Migration 044 is the canonical additive table baseline and must remain byte-for-byte unchanged if it may have been applied anywhere. Migration 045 tightens the two document read policies without changing write checks. Migration 046 adds a restricted, non-scheduled retention-maintenance function.

**Do not apply these migrations to Supabase, staging, production, or any shared database from this guide.** First run the complete sequence on a newly created disposable local PostgreSQL database. The current machine has PostgreSQL client/server tools and container runtimes unavailable, so real database verification has not been performed and the manual-application recommendation is NO-GO.

For a fresh disposable database only, the order is:

1. `migrations/044_ai_rag_persistent_conversations.sql`
2. `migrations/045_ai_document_active_version_rls.sql`
3. `migrations/046_ai_document_retention_maintenance.sql`
4. `migrations/verify_ai_rag_044_045.sql` (read-only post-check)

Use `psql -X -v ON_ERROR_STOP=1 -f <file>` with an explicitly verified disposable database URL; never use the main `.env` URL. Follow [AI_RLS_ISOLATED_POSTGRES_TEST_PLAN.md](AI_RLS_ISOLATED_POSTGRES_TEST_PLAN.md) for synthetic data and restricted-role tests.

Migration 046 creates a role with `BYPASSRLS`, which PostgreSQL only permits a superuser to set. It therefore requires a reviewed privileged database operator. That role is NOLOGIN and isolated as the function owner; do not grant it to the web application or a general login. Confirm the target operator's exact authority and recoverability before a future approved execution.

## If 044 or 045 may already be applied

Do not blindly rerun 044 or edit it in place. Run the read-only verification file and inspect exact columns, constraints, indexes, policy definitions, grants, RLS flags, and role attributes. Apply only a separately reviewed forward migration whose preconditions match the observed schema. Migration 046 deliberately fails if its maintenance roles, schema, or function already exist; inspect those objects and their ownership/grants instead of rerunning it.

The current candidate has no checksum-aware migration-history adoption. Database objects alone prove schema state, not execution provenance. Keep that distinction in operational records.

## Migration 046 behavior and operational gate

046 creates:

- `smarterp_ai_retention_owner`: NOLOGIN, non-superuser, BYPASSRLS; owns the security-definer function, has DELETE on the two AI tables and column-level SELECT only for document identifiers/company/retention/supersession and chunk identifier/parent/company keys. It has no table-wide SELECT and cannot read document text or chunk content.
- `smarterp_ai_retention_executor`: NOLOGIN, non-superuser, NOBYPASSRLS; the only granted function executor. No login role is made a member by the migration.
- `smarterp_ai_maintenance.purge_expired_documents(integer)`: fixed `search_path=pg_catalog`, fully qualified table references, bounded total row work 1–500 chunks plus document rows combined, row locks with `SKIP LOCKED`, company-paired candidate keys, atomic chunk/document deletion, and no caller-controlled tenant or SQL argument.
- `idx_ai_documents_retention_until` and `idx_ai_documents_company_superseded_by`: partial indexes supporting the bounded expiry scan and FK-safe supersession-chain order. These are the only 046 indexes; migration 044 remains unchanged.

Version allocation deliberately remains in the application under its existing family transaction advisory lock and the unique constraint. `db.js` derives `app.current_company_id`, `app.current_role`, and `app.current_user_id` from the server-side AsyncLocalStorage context established from authenticated `req.user`; the values are parameterized and written on each pool checkout before `SET ROLE smarterp_app`. They are still ordinary custom PostgreSQL settings that a party able to issue arbitrary SQL as `smarterp_app` could set. Therefore this candidate does not use those settings to authorize a `SECURITY DEFINER` version allocator. Without isolated PostgreSQL evidence or a separate non-GUC authorization primitive, the 100-collision ceiling remains and returns a safe 409 instead of performing an unbounded probe.

Rows are eligible only after their existing `retention_until` timestamp has elapsed. NULL and future deadlines remain. This conservative rule also applies to soft-deleted and superseded rows; there is no invented grace period. Self-referencing supersession rows are removed from chain roots first to respect the 044 `ON DELETE RESTRICT` FK. The function is global across companies and returns counts only, so its executor is a trusted maintenance identity with cross-tenant deletion authority. Review that operational trust explicitly.

An approved business/legal retention policy confirming that `retention_until` is the physical-deletion cutoff has not been independently verified in this source review. Do not grant a scheduler membership or invoke the function until the policy owner approves that interpretation, including its application to active, soft-deleted, and superseded rows.

046 does not schedule the function. After isolated tests and separate security approval, an operator must choose a supported scheduler, establish its login identity, grant that identity membership only in `smarterp_ai_retention_executor`, and verify it cannot assume `smarterp_ai_retention_owner` or `smarterp_app`. Until that work is separately approved and tested, cleanup is not automatic or operational.

## Stop conditions

Stop without applying the next file if any of these occur:

- The disposable target identity or database name is uncertain.
- Migration 044 columns, unique family/version constraint, self-FK, chunk FK, or forced RLS differ from the expected schema.
- Migration 045 does not leave exactly four AI policies, or any unexpected permissive policy exists.
- `smarterp_app` is superuser, has BYPASSRLS, has maintenance-role membership, has document DELETE, or has TRUNCATE.
- Migration 046 role/function/schema objects already exist with unknown ownership, memberships, grants, or definition.
- Any command fails, including a postcondition or RLS test. Do not continue to the next file after a failure.

## Required post-application evidence

Record the disposable database identity, PostgreSQL version, command, exit code, and outputs from the verifier. Test cross-company and unauthorized-role denial using separate `smarterp_app` sessions, then test active/deleted/superseded/expired documents, version collisions and concurrency, deletion/supersession/re-index transactions, maintenance batch boundaries, role denial, repeated calls, and concurrent cleanup. No mocked test can substitute for these PostgreSQL results.
