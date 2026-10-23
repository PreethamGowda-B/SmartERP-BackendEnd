# Invoice payment idempotency — migration 039 rollout draft

This is a prepared, additive rollout only. Migration `039_invoice_payment_idempotency.sql` is registered in the checksum-aware forward runner as a controlled migration and is excluded from application startup and `autoMigrate.js`. No migration was run in this pass.

## Schema and behavior

Migration 015 defines `invoice_payments` with nullable transaction references and no idempotency state. Migration 030's `invoices.idempotency_key` protects invoice creation and is not reused for payment records. Migration 039 adds nullable payment key, request fingerprint, and persisted outcome columns, plus a partial unique index on `(company_id, idempotency_key)`. Existing payment rows remain keyless and unchanged. The result constraint is `NOT VALID`: it enforces coherent new keyed rows while leaving historical rows untouched. RLS policies and role grants are not changed by the draft.

The application accepts an optional Idempotency-Key header. Keyed calls bind the company and normalized invoice, amount (two decimal places), method, transaction reference, and notes in a SHA-256 fingerprint. A same-key/same-fingerprint retry replays the original committed result. A mismatch returns HTTP 409. A missing idempotency schema returns HTTP 503 and never falls back to keyless insertion. Requests without a key retain the existing legacy path during compatibility rollout. A partial unique index is the database concurrency arbiter; PostgreSQL behavior is not claimed until verified in an isolated test database. The browser retains the key in tab-scoped session storage under a SHA-256 digest of the canonical intent so an uncertain retry after a page reload can reuse it without placing notes or references in the storage key; a confirmed success clears that entry.

## Deployment order

1. Confirm an explicitly isolated, dedicated test database (not the default `postgres` database) and perform read-only schema, migration-history, RLS, grants, duplicate-key/index, and role checks. The current source audit used earlier read-only preflight evidence; no migration was run in this pass.
2. Review the draft against the actual deployed invoice-payment table, role privileges, migration ledger, and supported PostgreSQL version. Resolve any existing index/constraint name collision before application.
3. Apply or adopt migration 039 to the isolated test database through the guarded integration runner's `--apply-migration` path, which uses the checksum-aware forward runner and advisory lock; do not use the application startup migration sweep. The runner refuses the default `postgres` database and refuses to replay partial untracked schema. Verify columns, partial unique index, constraint, RLS policy continuity, and grants.
4. Deploy the backend code. New keyed requests fail closed with 503 until step 3 is complete; old keyless clients remain compatible.
5. Deploy frontend clients that send one UUID key per unchanged payment intent and preserve it after uncertain failures. Changed request details produce a new key. Successful responses clear the client operation key.
6. Verify same-key replay, mismatch rejection, same-key concurrent requests, distinct-key installments, rollback, tenant isolation and old-client compatibility against isolated PostgreSQL. Only then consider production rollout.

## Rollback

Roll back frontend clients first, then the backend. Older code ignores the added nullable fields/index and continues the keyless path. Retain migration 039 and all payment rows during rollback; do not drop columns, remove the unique index, rewrite payments, or infer/delete duplicates. A later schema contraction requires a separate reviewed migration after all keyed traffic has ceased and history-retention requirements are confirmed.

## Evidence boundaries

The new application path and regression tests are mock-tested only. No PostgreSQL transaction, lock, uniqueness, RLS, browser, payment-provider, or production database behavior was exercised. No real payments or migrations were run.
