# SmartERP AI RLS migrations 044 and 045 — manual guide

## Which SQL files to use

- Canonical base migration: `migrations/044_ai_rag_persistent_conversations.sql`.
- Follow-up hardening: `migrations/045_ai_document_active_version_rls.sql`.
- Read-only checks: `migrations/verify_ai_rag_044_045.sql` (not a numbered migration).
- `docs/proposed-migrations/044_ai_rag_persistent_conversations.sql` is a superseded review copy. Do not execute it. It is not byte-identical to the canonical migration and omits the `REVOKE ALL ... FROM smarterp_app` before the intended grants.

Migration 044 was inspected but not changed. Do not replace or rerun a version already applied in an environment. If 044 has been applied there, verify its schema and apply only 045 after review. If it has not been applied, stop and confirm the target baseline and the approved one-time base-migration path before applying canonical 044 once, then 045.

The source migration runner currently registers 044 as a controlled migration,
excluded from startup execution. Migration 045 is intentionally not registered;
it is a manual follow-up. Running SQL in the Supabase Editor does not create an
`app_migration_history` record. The 044 file header contains stale wording that
says it is not registered; do not edit or rerun an already-applied migration to
correct that comment, because the runner stores a SHA-256 checksum. Before
asking the controlled runner to process 044 after a manual application, review
and approve a checksum-aware history adoption procedure.

## Before applying anything

1. In the Supabase Dashboard, confirm the project reference in the project selector and URL. Do not rely only on the SQL Editor's `current_database()` result; both projects can report `postgres`.
2. Confirm the selected project is the intended environment. Take a backup/recovery point and verify it is usable before any DDL.
3. Run `migrations/verify_ai_rag_044_045.sql`. Before 044, its 044 baseline checks should report false; the script remains read-only. After 044 and before 045, the four tables and exactly four policies should be present. Stop if a check fails or any policy differs from the expected definitions.
4. Confirm `public.users.id` is `uuid NOT NULL`, `smarterp_app` exists without `SUPERUSER` or `BYPASSRLS`, and the expected migration-044 grants/indexes/constraints are present. Migration 044 requires those prerequisites.
5. Never run SQL from `docs/proposed-migrations/` for migration 044.

## Execution order

- If 044 is already installed and verified in the selected project: run only `migrations/045_ai_document_active_version_rls.sql` in the Supabase SQL Editor.
- If 044 is absent: do not run 045. First resolve and approve the target's base-schema path; if approved, run the canonical 044 exactly once, verify it, then run 045.
- Migration 045 is transactional and fails closed if the expected tables, role, forced-RLS state, columns, or exact four-policy baseline are missing or incompatible. If Supabase reports an error, stop; do not rerun until the transaction outcome and current policies are inspected.

## After execution

1. Run the verification SQL again. Confirm four policies remain, the document and chunk `USING` predicates include deletion, supersession, and retention conditions, and the original `WITH CHECK` predicates remain lifecycle-compatible.
2. Confirm grants remain unchanged: no `TRUNCATE`; only the migration-044 `smarterp_app` grants; no browser-role table grants.
3. Test through the backend using its verified non-superuser `smarterp_app` connection, not only through SQL Editor as `postgres`. SQL Editor's owner role can bypass RLS.
4. In an isolated test environment with synthetic rows, verify cross-company reads return no rows; employees cannot read document rows; expired/deleted/superseded documents and their chunks are hidden; active documents/chunks remain visible to owner/admin; and upload, retry, re-index, supersession, and soft-delete still work.
5. Verify conversation/message company and user ownership behavior remains unchanged. Check citations against only active, ready search results.

The provided verification SQL is read-only and does not create test rows. Database behavior for synthetic lifecycle records must be tested in an approved isolated environment before release. No migration is production-verified by this guide.
