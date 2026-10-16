const REQUIRED_FIELDS = ['supplierName', 'invoiceNumber', 'invoiceDate', 'quantity', 'unit', 'total'];
const LOW_CONFIDENCE = 0.75;

function normalizedName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function compareInvoice({ request, invoice, extraction, duplicateInvoice = false }) {
  const discrepancies = [];
  const add = (code, severity, message, values = {}) => discrepancies.push({ code, severity, message, values });
  const quantity = Number(invoice.quantity ?? extraction?.quantity);
  const requestedQuantity = Number(request.quantity);
  const unit = String(invoice.unit ?? extraction?.unit ?? '').trim();
  const requestedUnit = String(request.unit || '').trim();
  const materialName = String(extraction?.materialName || request.item_name || '');

  if (!Number.isFinite(quantity) || quantity <= 0) add('quantity_missing', 'critical', 'Purchased quantity is required.');
  else if (!Number.isFinite(requestedQuantity) || Math.abs(quantity - requestedQuantity) > 0.001) {
    add('quantity_mismatch', 'critical', 'Purchased quantity differs from the approved request.', { requested: requestedQuantity, purchased: quantity });
  }
  if (!unit) add('unit_missing', 'critical', 'Purchased unit is required.');
  else if (requestedUnit && normalizedName(unit) !== normalizedName(requestedUnit)) {
    add('unit_mismatch', 'critical', 'Purchased unit differs from the approved request.', { requested: requestedUnit, purchased: unit });
  }
  if (extraction?.materialName && normalizedName(materialName) !== normalizedName(request.item_name)) {
    add('material_mismatch', 'critical', 'Invoice material does not match the approved request.', { requested: request.item_name, extracted: materialName });
  }
  if (extraction?.quantity != null && Number.isFinite(Number(extraction.quantity))
      && Math.abs(Number(extraction.quantity) - requestedQuantity) > 0.001) {
    add('extracted_quantity_mismatch', 'critical', 'AI-read invoice quantity differs from the approved request.', { requested: requestedQuantity, extracted: Number(extraction.quantity) });
  }
  if (extraction?.unit && requestedUnit && normalizedName(extraction.unit) !== normalizedName(requestedUnit)) {
    add('extracted_unit_mismatch', 'critical', 'AI-read invoice unit differs from the approved request.', { requested: requestedUnit, extracted: extraction.unit });
  }
  const textFields = ['supplierName', 'invoiceNumber', 'invoiceDate'];
  for (const field of textFields) {
    if (invoice[field] && extraction?.[field] && String(invoice[field]).trim().toLowerCase() !== String(extraction[field]).trim().toLowerCase()) {
      add(`manual_extraction_${field}_mismatch`, 'warning', `Manually entered ${field} differs from the AI-read invoice value; compare both with the original bill.`, { manual: invoice[field], extracted: extraction[field] });
    }
  }
  if (invoice.total != null && extraction?.total != null && Math.abs(Number(invoice.total) - Number(extraction.total)) > 0.02) {
    add('manual_extraction_total_mismatch', 'warning', 'Manually entered invoice total differs from the AI-read amount; verify it against the bill.', { manual: Number(invoice.total), extracted: Number(extraction.total) });
  }
  if (duplicateInvoice) add('duplicate_invoice', 'critical', 'This invoice number or file was already uploaded within this company.');

  const items = Array.isArray(extraction?.lineItems) ? extraction.lineItems : [];
  for (const [index, item] of items.entries()) {
    if (item.quantity != null && item.unitPrice != null && item.total != null
      && Math.abs(Number(item.quantity) * Number(item.unitPrice) - Number(item.total)) > 0.02) {
      add('line_arithmetic_mismatch', 'critical', `Invoice line ${index + 1} quantity × unit price does not equal its line total.`);
    }
  }
  const subtotal = invoice.subtotal ?? extraction?.subtotal;
  const tax = invoice.tax ?? extraction?.tax;
  const discount = invoice.discount ?? extraction?.discount ?? 0;
  const total = invoice.total ?? extraction?.total;
  if (subtotal != null && total != null && (tax != null || discount != null)) {
    const expected = Number(subtotal) + Number(tax || 0) - Number(discount || 0);
    if (Math.abs(expected - Number(total)) > 0.02) {
      add('invoice_arithmetic_mismatch', 'critical', 'Invoice subtotal, tax and discount do not add up to the invoice total.', { expected, total: Number(total) });
    }
  }
  if (extraction?.subtotal != null && extraction?.total != null && (extraction?.tax != null || extraction?.discount != null)) {
    const extractedExpected = Number(extraction.subtotal) + Number(extraction.tax || 0) - Number(extraction.discount || 0);
    if (Math.abs(extractedExpected - Number(extraction.total)) > 0.02) {
      add('extracted_invoice_arithmetic_mismatch', 'critical', 'AI-read invoice subtotal, tax and discount do not add up to its total.', { expected: extractedExpected, total: Number(extraction.total) });
    }
  }
  const confidence = extraction?.fieldConfidence || {};
  for (const field of REQUIRED_FIELDS) {
    const fieldValue = field === 'quantity' ? quantity : field === 'unit' ? unit : field === 'total' ? total : invoice[field] ?? extraction?.[field === 'supplierName' ? 'supplierName' : field === 'invoiceNumber' ? 'invoiceNumber' : field === 'invoiceDate' ? 'invoiceDate' : field];
    if (fieldValue == null || fieldValue === '') add(`${field}_unknown`, 'warning', `Invoice ${field} was not reliably extracted; confirm it from the bill.`);
    else if (extraction && Number(confidence[field]) < LOW_CONFIDENCE) add(`${field}_low_confidence`, 'warning', `Invoice ${field} has low extraction confidence and needs review.`);
  }

  const critical = discrepancies.some((item) => item.severity === 'critical');
  const review = discrepancies.length > 0;
  const aiStatus = !extraction ? 'unable_to_analyse' : critical ? 'ai_verification_failed' : review ? 'review_required' : 'ai_verification_passed';
  return { discrepancies, aiStatus };
}

function canFinalize({ bill, request, receivedConfirmed, acknowledgedDiscrepancies = [] }) {
  if (!bill || !request) return { ok: false, reason: 'Purchase bill or material request was not found.' };
  if (String(request.status).toLowerCase() !== 'accepted') return { ok: false, reason: 'The material request is no longer approved.' };
  if (bill.draft_status !== 'awaiting_owner_verification') return { ok: false, reason: 'Only the current bill draft awaiting owner verification can be finalized.' };
  if (bill.draft_status === 'verified' || bill.receipt_transaction_id) return { ok: false, reason: 'This draft has already been received into inventory.' };
  if (!receivedConfirmed) return { ok: false, reason: 'Confirm that the purchased materials were physically received before adding stock.' };
  if (!Number.isFinite(Number(bill.purchased_quantity)) || Number(bill.purchased_quantity) <= 0 || !bill.purchased_unit) {
    return { ok: false, reason: 'A valid purchased quantity and unit are required.' };
  }
  if (!bill.supplier_name || !bill.invoice_number || !bill.invoice_date || bill.invoice_total == null) {
    return { ok: false, reason: 'Supplier, invoice number, invoice date and total must be confirmed from the bill.' };
  }
  const discrepancies = Array.isArray(bill.discrepancies) ? bill.discrepancies : [];
  const critical = discrepancies.filter((item) => item.severity === 'critical');
  if (critical.length) return { ok: false, reason: 'Critical invoice discrepancies cannot be acknowledged. Request a corrected bill.' };
  const warningCodes = new Set(discrepancies.filter((item) => item.severity === 'warning').map((item) => item.code));
  const acknowledged = new Set(acknowledgedDiscrepancies);
  const missingAcknowledgements = [...warningCodes].filter((code) => !acknowledged.has(code));
  if (missingAcknowledgements.length) return { ok: false, reason: 'Review and acknowledge each non-critical AI warning before verification.', missingAcknowledgements };
  return { ok: true };
}

module.exports = { REQUIRED_FIELDS, LOW_CONFIDENCE, normalizedName, compareInvoice, canFinalize };
