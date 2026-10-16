'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireValidFileSignature } = require('../utils/fileValidation');
const OCRService = require('../services/ocrService');
const { normalizedName, compareInvoice, canFinalize } = require('../services/materialPurchaseRules');
const { createNotificationForOwners } = require('../utils/notificationHelpers');

const router = express.Router({ mergeParams: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png']);
    callback(allowed.has(String(file.mimetype || '').toLowerCase()) ? null : new Error('Only PDF, JPG, JPEG and PNG invoices are accepted.'), allowed.has(String(file.mimetype || '').toLowerCase()));
  },
});

router.use(authenticateToken);

const userIdOf = (user) => String(user?.userId || user?.id || '');
const companyIdOf = (user) => String(user?.companyId || user?.company_id || '');
const isApprover = (user) => ['owner', 'admin'].includes(String(user?.role || '').toLowerCase());
const positiveNumber = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const sanitizeFileName = (name) => path.basename(String(name || 'invoice')).replace(/[\r\n"\\]/g, '_').slice(0, 180) || 'invoice';
const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png'];

async function appendEvent(client, { companyId, requestId, billId, actorId, type, details = {} }) {
  await client.query(
    `INSERT INTO material_purchase_events(company_id, material_request_id, purchase_bill_id, actor_id, event_type, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [String(companyId), requestId, billId, actorId || null, type, JSON.stringify(details)]
  );
}

async function requestAccess(client, req, { lock = false } = {}) {
  const companyId = companyIdOf(req.user);
  const requestId = req.params.requestId;
  if (!companyId || !requestId) return null;
  const result = await client.query(
    `SELECT id, item_name, quantity, unit, description, status, purchase_status,
            requested_by, requested_by_name, reviewed_by, reviewed_at, company_id
       FROM material_requests
      WHERE id::text = $1::text AND company_id::text = $2::text${lock ? ' FOR UPDATE' : ''}`,
    [requestId, companyId]
  );
  const request = result.rows[0];
  if (!request) return null;
  if (!isApprover(req.user) && String(request.requested_by || '') !== userIdOf(req.user)) return null;
  return request;
}

function combinedInvoice(request, body, extraction) {
  const manual = {
    supplierName: body.supplier_name,
    invoiceNumber: body.invoice_number,
    invoiceDate: body.invoice_date,
    quantity: body.purchased_quantity,
    unit: body.purchased_unit,
    unitPrice: body.unit_price,
    subtotal: body.subtotal,
    discount: body.discount_amount,
    tax: body.tax_amount,
    total: body.invoice_total,
    currency: body.currency,
    gstin: body.supplier_gstin,
  };
  const fields = extraction ? { ...extraction, fieldConfidence: { ...(extraction.fieldConfidence || {}) } } : null;
  const merged = {};
  for (const [key, value] of Object.entries(manual)) {
    const cleanText = typeof value === 'string' ? value.trim() : value;
    if (cleanText !== '' && cleanText != null) {
      merged[key] = key === 'quantity' || ['unitPrice', 'subtotal', 'discount', 'tax', 'total'].includes(key)
        ? positiveNumber(cleanText) : cleanText;
    } else {
      merged[key] = extraction?.[key] ?? null;
    }
  }
  if (fields && !fields.materialName) fields.materialName = request.item_name;
  return { invoice: merged, comparisonExtraction: fields, originalExtraction: extraction };
}

async function notifyUser(payload) {
  try {
    const { createNotification } = require('../utils/notificationHelpers');
    await createNotification(payload);
  } catch (error) {
    console.warn('Material purchase notification failed:', error.code || error.name || 'notification_error');
  }
}

// Employee uploads. Requester/company authorization is checked inside a transaction before storing any bill.
router.post('/', upload.single('invoice'), requireValidFileSignature({ allowedMimes, fieldName: 'invoice', required: true }), async (req, res) => {
  const file = req.file;
  if (!file || !allowedMimes.includes(file.validatedMime)) return res.status(400).json({ message: 'Upload a valid PDF, JPG, JPEG or PNG invoice.' });
  if (String(file.mimetype).toLowerCase() !== file.validatedMime) return res.status(400).json({ message: 'The file extension or declared media type does not match its content.' });
  const numericFields = ['purchased_quantity', 'unit_price', 'subtotal', 'discount_amount', 'tax_amount', 'invoice_total'];
  for (const field of numericFields) {
    if (req.body[field] != null && req.body[field] !== '' && positiveNumber(req.body[field]) == null) {
      return res.status(400).json({ message: `${field.replaceAll('_', ' ')} must be a valid non-negative number.` });
    }
  }
  if (req.body.purchased_quantity != null && req.body.purchased_quantity !== '' && Number(req.body.purchased_quantity) <= 0) {
    return res.status(400).json({ message: 'Purchased quantity must be greater than zero.' });
  }
  if (req.body.invoice_date && !/^\d{4}-\d{2}-\d{2}$/.test(req.body.invoice_date)) {
    return res.status(400).json({ message: 'Invoice date must be a valid YYYY-MM-DD date.' });
  }
  if (req.body.invoice_date) {
    const parsedDate = new Date(`${req.body.invoice_date}T00:00:00Z`);
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== req.body.invoice_date) {
      return res.status(400).json({ message: 'Invoice date is not a real calendar date.' });
    }
  }
  const userId = userIdOf(req.user);
  const companyId = companyIdOf(req.user);
  if (!userId || !companyId || isApprover(req.user)) return res.status(403).json({ message: 'Only the requesting employee can upload a bill for this request.' });

  const fileName = sanitizeFileName(file.originalname);
  const fileSha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const client = await pool.connect();
  let request;
  let bill;
  try {
    await client.query('BEGIN');
    request = await requestAccess(client, req, { lock: true });
    if (!request) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Material request not found for this employee and company.' }); }
    if (String(request.status).toLowerCase() !== 'accepted') { await client.query('ROLLBACK'); return res.status(409).json({ message: 'Only an approved material request can accept a purchase invoice.' }); }

    const invoiceNumber = req.body.invoice_number?.trim();
    if (invoiceNumber) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invoice:${companyId}:${invoiceNumber.toLowerCase()}`]);
      const duplicateNumber = await client.query(
        `SELECT 1 FROM material_purchase_bills WHERE company_id=$1 AND LOWER(TRIM(invoice_number))=LOWER(TRIM($2)) LIMIT 1`,
        [companyId, invoiceNumber]
      );
      if (duplicateNumber.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ message: 'This invoice number was already uploaded within your company.' }); }
    }

    const duplicateFile = await client.query(
      `SELECT id::text, ai_status, draft_status FROM material_purchase_bills
        WHERE company_id = $1 AND material_request_id = $2 AND file_sha256 = $3 LIMIT 1`,
      [companyId, request.id, fileSha256]
    );
    if (duplicateFile.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ message: 'This exact invoice file was already uploaded for this request.', bill: duplicateFile.rows[0] }); }

    const latestResult = await client.query(
      `SELECT id, version, draft_status FROM material_purchase_bills
        WHERE company_id = $1 AND material_request_id = $2 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [companyId, request.id]
    );
    const previous = latestResult.rows[0];
    if (previous && !['correction_required', 'rejected', 'superseded'].includes(previous.draft_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'A bill is already awaiting owner review. Request correction before uploading a replacement.' });
    }
    const version = Number(previous?.version || 0) + 1;
    if (previous) {
      await client.query(`UPDATE material_purchase_bills SET draft_status = 'superseded', updated_at = NOW() WHERE id = $1`, [previous.id]);
    }
    const inserted = await client.query(
      `INSERT INTO material_purchase_bills
        (company_id, material_request_id, requested_by, approved_by, version, file_name, file_mime, file_size,
         file_sha256, file_data, supplier_name, invoice_number, invoice_date, purchased_quantity, purchased_unit,
         unit_price, subtotal, discount_amount, tax_amount, invoice_total, currency, supplier_gstin, notes, ai_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'processing')
       RETURNING id::text, version, created_at`,
      [companyId, request.id, userId, request.reviewed_by || null, version, fileName, file.validatedMime, file.size,
        fileSha256, file.buffer, req.body.supplier_name?.trim() || null, req.body.invoice_number?.trim() || null,
        req.body.invoice_date || null, positiveNumber(req.body.purchased_quantity), req.body.purchased_unit?.trim() || null,
        positiveNumber(req.body.unit_price), positiveNumber(req.body.subtotal), positiveNumber(req.body.discount_amount),
        positiveNumber(req.body.tax_amount), positiveNumber(req.body.invoice_total), req.body.currency?.trim() || null,
        req.body.supplier_gstin?.trim() || null, req.body.notes?.trim()?.slice(0, 1000) || null]
    );
    bill = inserted.rows[0];
    await client.query(`UPDATE material_requests SET purchase_status = 'processing', updated_at = NOW() WHERE id = $1`, [request.id]);
    await appendEvent(client, { companyId, requestId: request.id, billId: bill.id, actorId: userId, type: 'bill_uploaded', details: { version, file_name: fileName, file_sha256: fileSha256 } });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Material bill upload persistence failed:', error.code || error.name || 'db_error');
    if (error.code === '23505') return res.status(409).json({ message: 'This invoice file was already uploaded within your company.' });
    return res.status(500).json({ message: 'The invoice could not be saved. Please retry.' });
  } finally { client.release(); }

  // AI runs after the private file is durably stored. Failure preserves the upload as an explicit draft.
  try {
    const analysis = await OCRService.analyseInvoiceFile({ file: { ...file, validatedMime: file.validatedMime }, companyId });
    const extraction = analysis.parsedData || null;
    const { invoice, comparisonExtraction, originalExtraction } = combinedInvoice(request, req.body || {}, extraction);
    let duplicateInvoice = false;
    const invoiceNumbers = [...new Set([invoice.invoiceNumber, originalExtraction?.invoiceNumber].filter(Boolean).map((value) => String(value).trim().toLowerCase()))];
    if (invoiceNumbers.length) {
      const duplicate = await pool.query(
        `SELECT 1 FROM material_purchase_bills WHERE company_id = $1 AND id::text <> $2
          AND (LOWER(TRIM(invoice_number)) = ANY($3::text[]) OR file_sha256 = $4) LIMIT 1`,
        [companyId, bill.id, invoiceNumbers, fileSha256]
      );
      duplicateInvoice = duplicate.rows.length > 0;
    }
    if (!duplicateInvoice) {
      const duplicateFile = await pool.query(
        `SELECT 1 FROM material_purchase_bills WHERE company_id = $1 AND id::text <> $2 AND file_sha256 = $3 LIMIT 1`,
        [companyId, bill.id, fileSha256]
      );
      duplicateInvoice = duplicateFile.rows.length > 0;
    }
    const compared = compareInvoice({ request, invoice, extraction: analysis.status === 'analysed' ? comparisonExtraction : null, duplicateInvoice });
    const aiStatus = duplicateInvoice || compared.aiStatus === 'ai_verification_failed'
      ? 'ai_verification_failed'
      : analysis.status !== 'analysed' ? 'unable_to_analyse' : compared.aiStatus;
    const itemName = originalExtraction?.materialName || request.item_name;
    const inventoryMatches = await pool.query(
      `SELECT id, name, unit, supplier_name FROM inventory_items WHERE company_id::text = $1 AND COALESCE(is_deleted, FALSE) = FALSE`,
      [companyId]
    );
    const desiredName = normalizedName(itemName);
    const exact = inventoryMatches.rows.filter((item) => normalizedName(item.name) === desiredName
      && (!invoice.unit || !item.unit || normalizedName(item.unit) === normalizedName(invoice.unit)));
    let matchedItemId = exact.length === 1 ? exact[0].id : null;
    const discrepancies = compared.discrepancies.slice();
    if (exact.length > 1) discrepancies.push({ code: 'ambiguous_inventory_match', severity: 'warning', message: 'Multiple existing inventory items match this material; an owner must choose the correct record.', values: { candidates: exact.map((item) => ({ id: item.id, name: item.name, unit: item.unit })) } });
    const historicalSuppliers = [...new Set(inventoryMatches.rows.filter((item) => normalizedName(item.name) === desiredName && item.supplier_name).map((item) => String(item.supplier_name).trim()))];
    if (invoice.supplierName && historicalSuppliers.length && !historicalSuppliers.some((supplier) => normalizedName(supplier) === normalizedName(invoice.supplierName))) {
      discrepancies.push({ code: 'supplier_history_mismatch', severity: 'warning', message: 'This supplier differs from the supplier recorded for matching company inventory.', values: { historical_suppliers: historicalSuppliers } });
    }
    if (exact.length === 0) {
      const words = new Set(desiredName.split(' ').filter((word) => word.length > 2));
      const candidates = inventoryMatches.rows.map((item) => ({ item, score: [...words].filter((word) => normalizedName(item.name).split(' ').includes(word)).length / Math.max(1, words.size) }))
        .filter(({ score }) => score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 5);
      if (candidates.length) discrepancies.push({ code: 'possible_inventory_match', severity: 'warning', message: 'Similar inventory items exist; confirm whether this bill belongs to one of them.', values: { candidates: candidates.map(({ item }) => ({ id: item.id, name: item.name, unit: item.unit })) } });
    }
    let finalAiStatus = aiStatus === 'ai_verification_passed' && discrepancies.length ? 'review_required' : aiStatus;
    const updateClient = await pool.connect();
    try {
      await updateClient.query('BEGIN');
      if (invoiceNumbers.length) {
        for (const number of invoiceNumbers.sort()) {
          await updateClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invoice:${companyId}:${number}`]);
        }
        const duplicate = await updateClient.query(
          `SELECT 1 FROM material_purchase_bills WHERE company_id=$1 AND id::text<>$2 AND LOWER(TRIM(invoice_number))=ANY($3::text[]) LIMIT 1`,
          [companyId, bill.id, invoiceNumbers]
        );
        if (duplicate.rows.length && !discrepancies.some((item) => item.code === 'duplicate_invoice')) {
          discrepancies.push({ code: 'duplicate_invoice', severity: 'critical', message: 'This invoice number was already uploaded within this company.' });
          finalAiStatus = 'ai_verification_failed';
        }
      }
      const stored = await updateClient.query(
        `UPDATE material_purchase_bills SET supplier_name = COALESCE($1,supplier_name), invoice_number = COALESCE($2,invoice_number),
                invoice_date = COALESCE($3::date,invoice_date), purchased_quantity = COALESCE($4,purchased_quantity),
                purchased_unit = COALESCE($5,purchased_unit), unit_price = COALESCE($6,unit_price), subtotal = COALESCE($7,subtotal),
                discount_amount = COALESCE($8,discount_amount), tax_amount = COALESCE($9,tax_amount), invoice_total = COALESCE($10,invoice_total),
                currency = COALESCE($11,currency), supplier_gstin = COALESCE($12,supplier_gstin), extraction = $13::jsonb,
                discrepancies = $14::jsonb, ai_status = $15, matched_inventory_item_id = $16, updated_at = NOW()
          WHERE id::text = $17 AND company_id = $18 AND draft_status = 'awaiting_owner_verification' RETURNING id`,
        [invoice.supplierName, invoice.invoiceNumber, invoice.invoiceDate, invoice.quantity, invoice.unit, invoice.unitPrice,
          invoice.subtotal, invoice.discount, invoice.tax, invoice.total, invoice.currency, invoice.gstin,
          JSON.stringify({ status: analysis.status, reason: analysis.reason || null, fields: originalExtraction }),
          JSON.stringify(discrepancies), finalAiStatus, matchedItemId, bill.id, companyId]
      );
      if (!stored.rows.length) throw new Error('Bill status changed while analysis was running.');
      const purchaseStatus = finalAiStatus === 'ai_verification_passed' ? 'ready_for_owner' : finalAiStatus;
      await updateClient.query(`UPDATE material_requests SET purchase_status = $1, updated_at = NOW() WHERE id = $2 AND company_id::text = $3`, [purchaseStatus, request.id, companyId]);
      await appendEvent(updateClient, { companyId, requestId: request.id, billId: bill.id, actorId: userId, type: 'ai_analysis_completed', details: { ai_status: finalAiStatus, discrepancy_count: discrepancies.length } });
      await updateClient.query('COMMIT');
    } catch (error) {
      await updateClient.query('ROLLBACK').catch(() => {});
      console.error('Material invoice analysis result was not stored:', error.code || error.name || 'analysis_save_error');
      return res.status(202).json({ success: true, bill_id: bill.id, status: 'processing', message: 'Invoice was securely saved; analysis result could not be saved yet. Refresh the request.' });
    } finally { updateClient.release(); }
    try {
      await createNotificationForOwners({ company_id: companyId, type: 'material_purchase_bill', title: 'Purchase bill ready for review', message: `${request.item_name} is awaiting inventory verification.`, priority: 'medium', data: { request_id: request.id, bill_id: bill.id, url: '/owner/inventory?tab=materials' } });
    } catch (error) { console.warn('Material purchase owner notification failed:', error.code || error.name || 'notification_error'); }
    return res.status(201).json({ success: true, bill_id: bill.id, ai_status: finalAiStatus, discrepancies, draft_status: 'awaiting_owner_verification' });
  } catch (error) {
    console.warn('Material invoice analysis failed:', error.code || error.name || 'analysis_error');
    const fallbackClient = await pool.connect();
    try {
      await fallbackClient.query('BEGIN');
      await fallbackClient.query(
        `UPDATE material_purchase_bills SET ai_status='unable_to_analyse', extraction=$1::jsonb, updated_at=NOW()
          WHERE id::text=$2 AND company_id=$3 AND draft_status='awaiting_owner_verification'`,
        [JSON.stringify({ status: 'unable_to_analyse', reason: 'Analysis could not be completed. Manual owner review is required.' }), bill.id, companyId]
      );
      await fallbackClient.query(`UPDATE material_requests SET purchase_status='unable_to_analyse', updated_at=NOW() WHERE id=$1 AND company_id::text=$2`, [request.id, companyId]);
      await appendEvent(fallbackClient, { companyId, requestId: request.id, billId: bill.id, actorId: userId, type: 'ai_analysis_unavailable', details: {} });
      await fallbackClient.query('COMMIT');
    } catch (saveError) { await fallbackClient.query('ROLLBACK').catch(() => {}); }
    finally { fallbackClient.release(); }
    return res.status(202).json({ success: true, bill_id: bill.id, ai_status: 'unable_to_analyse', draft_status: 'awaiting_owner_verification', message: 'Invoice was saved securely but could not be analysed. It remains a draft for owner review.' });
  }
});

// Scoped bill list and history for the owner or the employee who submitted the request.
router.get('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const request = await requestAccess(client, req);
    if (!request) return res.status(404).json({ message: 'Material request not found for this user and company.' });
    const bills = await client.query(
      `SELECT id::text, material_request_id, requested_by::text, approved_by::text, version, file_name, file_mime, file_size,
              supplier_name, invoice_number, invoice_date, purchased_quantity, purchased_unit, unit_price, subtotal,
              discount_amount, tax_amount, invoice_total, currency, supplier_gstin, notes, extraction, discrepancies,
              ai_status, draft_status, matched_inventory_item_id, rejection_reason, verified_by::text, verified_at,
              receipt_transaction_id::text, received_confirmed, created_at, updated_at
         FROM material_purchase_bills WHERE company_id = $1 AND material_request_id = $2 ORDER BY version DESC`,
      [companyIdOf(req.user), request.id]
    );
    const events = await client.query(
      `SELECT event_type, actor_id::text, details, created_at FROM material_purchase_events
        WHERE company_id = $1 AND material_request_id = $2 ORDER BY created_at`,
      [companyIdOf(req.user), request.id]
    );
    return res.json({ request, bills: bills.rows.map((bill) => ({ ...bill, file_url: `/api/material-requests/${request.id}/purchase-bills/${bill.id}/file` })), events: events.rows });
  } catch (error) {
    console.error('Material purchase bill list failed:', error.code || error.name || 'db_error');
    return res.status(500).json({ message: 'Unable to retrieve purchase bills.' });
  } finally { client.release(); }
});

// Private inline file preview/download. No public cloud URL is issued.
router.get('/:billId/file', async (req, res) => {
  const request = await requestAccess(pool, req).catch(() => null);
  if (!request) return res.status(404).json({ message: 'Purchase bill not found.' });
  try {
    const result = await pool.query(
      `SELECT file_name, file_mime, file_data FROM material_purchase_bills
        WHERE id::text = $1 AND company_id = $2 AND material_request_id = $3`,
      [req.params.billId, companyIdOf(req.user), request.id]
    );
    const file = result.rows[0];
    if (!file) return res.status(404).json({ message: 'Purchase bill not found.' });
    res.set({
      'Content-Type': file.file_mime,
      'Content-Disposition': `inline; filename="${sanitizeFileName(file.file_name)}"`,
      'Content-Length': String(file.file_data.length),
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    return res.status(200).send(file.file_data);
  } catch (error) {
    console.error('Private invoice preview failed:', error.code || error.name || 'db_error');
    return res.status(500).json({ message: 'Unable to open invoice file.' });
  }
});

// Final stock receipt: owner confirmation, stock update, receipt ledger and bill finalization commit atomically.
router.post('/:billId/verify', async (req, res) => {
  if (!isApprover(req.user)) return res.status(403).json({ message: 'Only an owner or authorized administrator may verify purchase bills.' });
  const companyId = companyIdOf(req.user);
  const actorId = userIdOf(req.user);
  const client = await pool.connect();
  let finalized;
  try {
    await client.query('BEGIN');
    const requestResult = await client.query(
      `SELECT * FROM material_requests WHERE id::text = $1 AND company_id::text = $2 FOR UPDATE`,
      [req.params.requestId, companyId]
    );
    const request = requestResult.rows[0];
    const billResult = await client.query(
      `SELECT * FROM material_purchase_bills WHERE id::text = $1 AND material_request_id::text = $2 AND company_id = $3 FOR UPDATE`,
      [req.params.billId, req.params.requestId, companyId]
    );
    const bill = billResult.rows[0];
    if (!request || !bill) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Purchase bill not found for this company and request.' }); }
    const latestResult = await client.query(
      `SELECT id::text FROM material_purchase_bills WHERE company_id = $1 AND material_request_id = $2 ORDER BY version DESC LIMIT 1`,
      [companyId, request.id]
    );
    if (latestResult.rows[0]?.id !== String(bill.id)) { await client.query('ROLLBACK'); return res.status(409).json({ message: 'This invoice was superseded and cannot add stock.' }); }
    const discrepancies = Array.isArray(bill.discrepancies) ? bill.discrepancies : [];
    const decision = canFinalize({ bill, request, receivedConfirmed: req.body?.received_confirmed === true, acknowledgedDiscrepancies: req.body?.acknowledged_discrepancies || [] });
    if (!decision.ok) { await client.query('ROLLBACK'); return res.status(409).json({ message: decision.reason, missing_acknowledgements: decision.missingAcknowledgements }); }

    const quantity = Number(bill.purchased_quantity);
    let inventoryItemId = req.body?.inventory_item_id || bill.matched_inventory_item_id || null;
    let inventoryItem;
    if (inventoryItemId) {
      const itemRes = await client.query(
        `SELECT * FROM inventory_items WHERE id::text = $1 AND company_id::text = $2 AND COALESCE(is_deleted,FALSE) = FALSE FOR UPDATE`,
        [String(inventoryItemId), companyId]
      );
      inventoryItem = itemRes.rows[0];
      if (!inventoryItem) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Selected inventory item is not available in this company.' }); }
      if (inventoryItem.unit && normalizedName(inventoryItem.unit) !== normalizedName(bill.purchased_unit)) {
        await client.query('ROLLBACK'); return res.status(409).json({ message: 'Invoice unit does not match the selected inventory item.' });
      }
      const sameName = normalizedName(inventoryItem.name) === normalizedName(request.item_name);
      const mappingReason = String(req.body?.mapping_reason || '').trim();
      if (!sameName && mappingReason.length < 8) {
        await client.query('ROLLBACK'); return res.status(400).json({ message: 'Provide a reason of at least 8 characters to map this request to a differently named stock item.' });
      }
    } else {
      // Serialize new-item name checks so concurrent verifications cannot create near-identical items.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`material:${companyId}:${normalizedName(request.item_name)}`]);
      const existing = await client.query(
        `SELECT * FROM inventory_items WHERE company_id::text = $1 AND COALESCE(is_deleted,FALSE) = FALSE
          AND LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', ' ', 'g')) = LOWER(REGEXP_REPLACE($2, '[^a-zA-Z0-9]+', ' ', 'g')) FOR UPDATE`,
        [companyId, request.item_name]
      );
      if (existing.rows.length > 1) { await client.query('ROLLBACK'); return res.status(409).json({ message: 'Multiple inventory matches need owner selection before receipt.' }); }
      inventoryItem = existing.rows[0];
      if (inventoryItem && inventoryItem.unit && normalizedName(inventoryItem.unit) !== normalizedName(bill.purchased_unit)) {
        await client.query('ROLLBACK'); return res.status(409).json({ message: 'Existing inventory unit differs from the purchased unit.' });
      }
      if (inventoryItem) inventoryItemId = inventoryItem.id;
    }

    if (!inventoryItem) {
      const created = await client.query(
        `INSERT INTO inventory_items(name, description, quantity, created_by, employee_name, category, unit,
           min_quantity, supplier_name, company_id, created_at, updated_at, source_type, source_reference)
         VALUES ($1,$2,0,$3,$4,'Supplies',$5,0,$6,$7,NOW(),NOW(),'material_request_receipt',$8) RETURNING *`,
        [request.item_name, request.description || null, actorId, request.requested_by_name || null,
          bill.purchased_unit, bill.supplier_name, companyId, `MR-${request.id}`]
      );
      inventoryItem = created.rows[0];
      inventoryItemId = inventoryItem.id;
    }

    const stockUpdate = await client.query(
      `UPDATE inventory_items SET quantity = COALESCE(quantity,0) + $1, unit = COALESCE(unit,$2), supplier_name = COALESCE($3,supplier_name),
              updated_by = $4, updated_at = NOW()
        WHERE id = $5 AND company_id::text = $6 RETURNING *`,
      [quantity, bill.purchased_unit, bill.supplier_name, actorId, inventoryItemId, companyId]
    );
    if (!stockUpdate.rows.length) throw new Error('Inventory item changed while the receipt was being finalized.');
    const receipt = await client.query(
      `INSERT INTO inventory_stock_transactions
        (company_id, inventory_item_id, transaction_type, source_type, source_reference, material_request_id,
         purchase_bill_id, quantity, unit, invoice_number, performed_by)
       VALUES ($1,$2,'receipt','material_request_receipt',$3,$4,$5,$6,$7,$8,$9)
       RETURNING id::text, created_at`,
      [companyId, inventoryItemId, `MR-${request.id}`, request.id, bill.id, quantity, bill.purchased_unit, bill.invoice_number, actorId]
    );
    const receiptId = receipt.rows[0].id;
    await client.query(
      `UPDATE material_purchase_bills SET draft_status='verified', verified_by=$1, verified_at=NOW(),
              receipt_transaction_id=$2::uuid, received_confirmed=TRUE, matched_inventory_item_id=$3, updated_at=NOW()
        WHERE id=$4 AND company_id=$5 AND receipt_transaction_id IS NULL`,
      [actorId, receiptId, inventoryItemId, bill.id, companyId]
    );
    await client.query(`UPDATE material_requests SET status='delivered', purchase_status='verified', updated_at=NOW() WHERE id=$1 AND company_id::text=$2`, [request.id, companyId]);
    await appendEvent(client, { companyId, requestId: request.id, billId: bill.id, actorId, type: 'owner_verified_and_received', details: { receipt_transaction_id: receiptId, inventory_item_id: inventoryItemId, quantity, unit: bill.purchased_unit } });
    await client.query('COMMIT');
    finalized = { receiptId, inventoryItemId, quantity, unit: bill.purchased_unit, request };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ message: 'This invoice has already been received into inventory.' });
    console.error('Material purchase receipt transaction rolled back:', error.code || error.name || 'db_error');
    return res.status(500).json({ message: 'Inventory receipt failed and no stock change was committed.' });
  } finally { client.release(); }

  await notifyUser({ user_id: finalized.request.requested_by, company_id: companyId, type: 'material_purchase_verified', title: 'Purchase bill verified', message: `${finalized.quantity} ${finalized.unit} of ${finalized.request.item_name} was received into inventory.`, priority: 'medium', data: { request_id: finalized.request.id, url: '/employee/materials' } });
  return res.json({ success: true, message: 'Purchase bill verified and stock receipt recorded.', receipt_transaction_id: finalized.receiptId, inventory_item_id: finalized.inventoryItemId, quantity: finalized.quantity, unit: finalized.unit });
});

router.post('/:billId/correction', async (req, res) => {
  if (!isApprover(req.user)) return res.status(403).json({ message: 'Only an owner or authorized administrator can request corrections.' });
  const reason = String(req.body?.reason || '').trim();
  const action = req.body?.action === 'reject' ? 'rejected' : 'correction_required';
  if (reason.length < 8 || reason.length > 1000) return res.status(400).json({ message: 'A correction or rejection reason between 8 and 1000 characters is required.' });
  const client = await pool.connect();
  let employeeId;
  let requestId;
  try {
    await client.query('BEGIN');
    const request = await requestAccess(client, req, { lock: true });
    if (!request) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Material request not found for this company.' }); }
    const billRes = await client.query(
      `SELECT * FROM material_purchase_bills WHERE id::text=$1 AND material_request_id=$2 AND company_id=$3 FOR UPDATE`,
      [req.params.billId, request.id, companyIdOf(req.user)]
    );
    const bill = billRes.rows[0];
    if (!bill || bill.draft_status === 'verified' || bill.receipt_transaction_id) { await client.query('ROLLBACK'); return res.status(409).json({ message: 'This bill cannot be rejected or changed.' }); }
    await client.query(`UPDATE material_purchase_bills SET draft_status=$1, rejection_reason=$2, updated_at=NOW() WHERE id=$3`, [action, reason, bill.id]);
    await client.query(`UPDATE material_requests SET purchase_status=$1, updated_at=NOW() WHERE id=$2`, [action, request.id]);
    await appendEvent(client, { companyId: companyIdOf(req.user), requestId: request.id, billId: bill.id, actorId: userIdOf(req.user), type: action, details: { reason } });
    await client.query('COMMIT');
    employeeId = request.requested_by;
    requestId = request.id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Material bill correction status failed:', error.code || error.name || 'db_error');
    return res.status(500).json({ message: 'Unable to save the correction request.' });
  } finally { client.release(); }
  await notifyUser({ user_id: employeeId, company_id: companyIdOf(req.user), type: 'material_purchase_correction', title: 'Purchase invoice needs correction', message: reason, priority: 'high', data: { request_id: requestId, url: '/employee/materials' } });
  return res.json({ success: true, draft_status: action });
});

module.exports = router;
