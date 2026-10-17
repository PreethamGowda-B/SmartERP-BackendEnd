# SmartERP Invoice Consolidation Report

**Scope:** Source-code review and local implementation for the invoice workflow. No production API, database, invoice, payment, commit, push, or deployment was performed.

## Summary

`services/invoiceService.js` is now the single persistence and lifecycle engine for job drafts, job invoice issuance, direct/walk-in invoices, finalization, and dispute reissues. `services/invoiceMath.js` provides shared line-item and tax calculations. Legacy service entry points delegate to this engine. Owner review remains required before issuance; completion and customer sign-off no longer create or issue a minimal invoice behind the owner's back.

The changes address the identified paths statically and with mocked/unit tests. They have not been verified against a live database or production deployment. Existing historical invoice data is not migrated or rewritten by these changes.

## Canonical workflow and migrated callers

- `services/invoiceService.js` owns invoice transactions, numbering, idempotency, item persistence, AR schedule updates, invoice status, inventory movements, and the job/direct/reissue workflows.
- `services/invoiceMath.js` computes rounded line totals, labor, charges, discount, subtotal, and GST (CGST/SGST or IGST) for all supported line-item types.
- `services/billingService.js` remains as a compatibility wrapper and delegates draft creation to `invoiceService.createJobDraft`.
- `services/gstInvoiceService.js` remains as a compatibility wrapper and delegates direct invoice persistence to `invoiceService.createDirectInvoice`.
- `routes/jobs.js` `POST /api/jobs/:id/invoice` now creates/returns a canonical draft for owner review; it no longer independently creates an issued invoice or PDF.
- `routes/proofOfWork.js` customer sign-off still records sign-off/completion, but does not issue an invoice.
- Job progress completion no longer creates an invoice draft automatically. The owner can issue from the completed job's invoice editor.
- The job detail Issue Invoice action preserves the job context and opens the editor with the selected job/customer. The editor finalizes drafts through `/api/invoices/finalize` and handles disputed invoices through `/api/invoices/:id/reissue`.
- The direct invoice modal calls `/api/invoices/direct-create`, retains an idempotency key through retries, and resets it only after success.
- The Finance invoice list exposes review/issue for drafts; the invoice view only allows editing/revision for draft/disputed states.

## Lifecycle and data consistency

Job invoices are created as drafts through the canonical service. Finalization locks and updates the existing draft, writes invoice items, assigns the invoice number, stores the PDF reference, and creates/updates the AR collection schedule in the same transaction. It does not insert a second invoice when finalizing an existing draft. Issued/paid invoices are immutable through ordinary finalization.

Direct invoices and invoice reissues require idempotency keys. New direct invoices insert the invoice and line items and apply any inventory decrement transactionally; a failed stock update aborts rather than silently issuing or decrementing twice. Job issuance serializes on the job row, and invoice number allocation locks the tenant company row before allocating the next number. Reissue preserves the parent link and version lineage, carries line items if no replacement items are supplied, updates AR/PDF references, and refuses automatic reissue when the parent has recorded payments so payment history is not silently rewritten.

Material preparation filters requests by both selected `job_id` and `company_id`. Requests without a job link are not automatically attributed to a job. No fabricated material cost is added when a purchase cost is absent.

PDF generation now returns PDF 1.4 bytes with a valid cross-reference table, and the PDF endpoint responds as `application/pdf`; it no longer labels HTML as a PDF.

## API and authorization changes

- Direct create and finalize require an owner/admin/super-admin role and an idempotency key.
- Reissue is owner/admin/super-admin only and delegates tenant-scoped lookup and transaction handling to the canonical service.
- Job draft and invoice operations retain company-scoped job/invoice access checks.
- Payment recording and customer invoice viewing routes were not intentionally redesigned. Customer invoice issuance notifications and job events remain on successful, non-replayed issuance.

## Schema changes

Two additive migrations were added and registered in `migrations/autoMigrate.js`:

- `030_invoice_idempotency.sql` adds nullable `invoices.idempotency_key` and a partial unique index on `(company_id, idempotency_key)` for non-null keys.
- `031_material_request_job_scope.sql` adds nullable `material_requests.job_id`, a same-database job foreign key, and a company/job index.

These migrations do not delete records or rewrite historical totals/statuses. Existing material requests remain unassociated (`job_id IS NULL`) unless a separately reviewed backfill is designed. No automatic cleanup of duplicate, malformed, or historical invoices was performed. Before enabling the migrations in a deployed environment, run the project's normal migration review/deployment process and verify the actual deployed schema.

## Regression checks run

Executed locally:

- `node --test tests/invoice_consolidation.test.js` — **15 passed, 0 failed**. Coverage includes shared calculations, invalid values, valid/multipage PDF structure, legacy wrapper delegation, tenant-row number locking, job/company material filtering, cross-company job denial, no sign-off/progress invoice insertion, completed-job issuance links, draft finalization with PDF/AR, immutable issued invoices, and direct-create idempotency/inventory replay.
- `node --check` on the modified backend JavaScript files and the new test file — passed (syntax only).
- A generated sample invoice was inspected with `pdfinfo` — one page and recognized as PDF. The temporary file was removed.
- Frontend `npx tsc --noEmit --pretty false` — passed with no diagnostics.

Not run:

- `tests/e2e_finance_verification.test.js` uses a database and writes invoice/payment records. It was not run because no isolated test database was established and the user prohibited production data changes. Its finalize/reissue calls were updated to supply idempotency keys.
- Frontend `npm run build` could not complete: Next.js failed creating `.next/types/app/hr/leave` with `EPERM`. TypeScript checking passed, but this does not substitute for a successful production build.
- No live workflow, deployed API, production database, customer notification delivery, payment recording, or cross-company runtime test was performed.

## Known limits and reconciliation

- New number allocation is serialized through the company row and uses existing company invoice numbers as its counter source. It avoids the previous count-based race for concurrent requests using this service, but there is no destructive cleanup or uniqueness migration for pre-existing duplicate invoice numbers. A dedicated database counter/unique constraint can be considered after auditing existing tenant data.
- The added idempotency constraint protects new requests that supply keys. Historical invoices have null keys and remain unchanged.
- Existing historical duplicates, malformed PDF references, invoices with inconsistent AR rows, and old material requests without `job_id` need a per-company, read-only inventory and owner-approved reconciliation plan before any data correction.
- Reissue with payments is rejected (409) pending payment reconciliation; it does not attempt to redistribute payments.
- PDF layout is a simple generated invoice document, not a branded template. The output is a real PDF, but visual/template acceptance should be checked separately.
- The local regression suite uses mocks for database workflows; database constraint behavior and migrations still need validation in an isolated staging/test database.

## Repository state note

The workspace already contained unrelated payroll, notification, and customer-notification edits before this invoice work. They were preserved and are not covered by this report. No commit or push was made.
