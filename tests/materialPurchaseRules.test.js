'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareInvoice, canFinalize } = require('../services/materialPurchaseRules');
const { normalizeParsed } = require('../services/ocrService');

const request = { id: 17, item_name: 'Copper Wire', quantity: 5, unit: 'meters', status: 'accepted' };
const extraction = {
  supplierName: 'Acme Supplies', invoiceNumber: 'INV-17', invoiceDate: '2026-10-01', materialName: 'Copper Wire',
  quantity: 5, unit: 'meters', unitPrice: 100, subtotal: 500, discount: 0, tax: 0, total: 500,
  fieldConfidence: Object.fromEntries(['supplierName', 'invoiceNumber', 'invoiceDate', 'materialName', 'quantity', 'unit', 'unitPrice', 'subtotal', 'discount', 'tax', 'total'].map((key) => [key, 0.99])),
  lineItems: [],
};
const invoice = { supplierName: 'Acme Supplies', invoiceNumber: 'INV-17', invoiceDate: '2026-10-01', quantity: 5, unit: 'meters', unitPrice: 100, subtotal: 500, discount: 0, tax: 0, total: 500 };
const bill = { draft_status: 'awaiting_owner_verification', purchased_quantity: 5, purchased_unit: 'meters', supplier_name: 'Acme Supplies', invoice_number: 'INV-17', invoice_date: '2026-10-01', invoice_total: 500, discrepancies: [] };
const finalize = (overrides = {}) => canFinalize({ bill: { ...bill, ...overrides }, request, receivedConfirmed: true, acknowledgedDiscrepancies: [] });

test('01 accepted employee bill can be compared against its approved request', () => {
  assert.equal(compareInvoice({ request, invoice, extraction }).aiStatus, 'ai_verification_passed');
});
test('02 unapproved material request cannot enter a purchase bill flow', () => {
  assert.equal(canFinalize({ bill, request: { ...request, status: 'pending' }, receivedConfirmed: true }).ok, false);
});
test('03 normalized AI fields preserve known invoice values and unknowns', () => {
  const parsed = normalizeParsed({ ...extraction, quantity: '5', total: '500', fieldConfidence: { quantity: 0.9 } });
  assert.equal(parsed.quantity, 5); assert.equal(parsed.total, 500); assert.equal(parsed.supplierName, 'Acme Supplies');
});
test('04 requested versus purchased quantity mismatch is critical', () => {
  const result = compareInvoice({ request, invoice: { ...invoice, quantity: 4 }, extraction });
  assert.ok(result.discrepancies.some((item) => item.code === 'quantity_mismatch' && item.severity === 'critical'));
});
test('04a manually entered quantity cannot hide an AI-read mismatch', () => {
  const result = compareInvoice({ request, invoice: { ...invoice, quantity: 5 }, extraction: { ...extraction, quantity: 4 } });
  assert.ok(result.discrepancies.some((item) => item.code === 'extracted_quantity_mismatch' && item.severity === 'critical'));
});
test('05 requested versus purchased unit mismatch is critical', () => {
  assert.ok(compareInvoice({ request, invoice: { ...invoice, unit: 'kg' }, extraction }).discrepancies.some((item) => item.code === 'unit_mismatch'));
});
test('06 invoice material mismatch is critical', () => {
  assert.ok(compareInvoice({ request, invoice, extraction: { ...extraction, materialName: 'Steel Bolt' } }).discrepancies.some((item) => item.code === 'material_mismatch'));
});
test('07 inconsistent line arithmetic is critical', () => {
  const result = compareInvoice({ request, invoice, extraction: { ...extraction, lineItems: [{ quantity: 2, unitPrice: 10, total: 25 }] } });
  assert.ok(result.discrepancies.some((item) => item.code === 'line_arithmetic_mismatch'));
});
test('08 inconsistent invoice subtotal and tax arithmetic is critical', () => {
  const result = compareInvoice({ request, invoice: { ...invoice, total: 510, tax: 5 }, extraction });
  assert.ok(result.discrepancies.some((item) => item.code === 'invoice_arithmetic_mismatch'));
});
test('09 duplicate invoice identifier or file is critical', () => {
  assert.ok(compareInvoice({ request, invoice, extraction, duplicateInvoice: true }).discrepancies.some((item) => item.code === 'duplicate_invoice'));
});
test('10 unreadable invoice is reported as unable to analyse', () => {
  assert.equal(compareInvoice({ request, invoice: {}, extraction: null }).aiStatus, 'unable_to_analyse');
});
test('11 missing invoice fields are warnings and never guessed', () => {
  const result = compareInvoice({ request, invoice: { quantity: 5, unit: 'meters' }, extraction: { quantity: 5, unit: 'meters', fieldConfidence: {} } });
  assert.ok(result.discrepancies.some((item) => item.code === 'supplierName_unknown'));
  assert.ok(result.discrepancies.some((item) => item.code === 'invoiceNumber_unknown'));
});
test('12 low-confidence AI extraction triggers owner review', () => {
  const result = compareInvoice({ request, invoice, extraction: { ...extraction, fieldConfidence: { ...extraction.fieldConfidence, supplierName: 0.2 } } });
  assert.equal(result.aiStatus, 'review_required');
});
test('13 uploading a draft alone does not meet physical receipt confirmation', () => {
  assert.equal(canFinalize({ bill, request, receivedConfirmed: false }).ok, false);
});
test('14 a delivered request cannot be finalized again', () => {
  const result = canFinalize({ bill, request: { ...request, status: 'delivered' }, receivedConfirmed: true });
  assert.equal(result.ok, false);
});
test('15 missing supplier metadata blocks finalization', () => {
  assert.equal(finalize({ supplier_name: null }).ok, false);
});
test('16 missing invoice number blocks finalization', () => {
  assert.equal(finalize({ invoice_number: null }).ok, false);
});
test('17 missing invoice date blocks finalization', () => {
  assert.equal(finalize({ invoice_date: null }).ok, false);
});
test('18 missing invoice total blocks finalization', () => {
  assert.equal(finalize({ invoice_total: null }).ok, false);
});
test('19 critical discrepancies cannot be overridden by acknowledgement', () => {
  const result = canFinalize({ bill: { ...bill, discrepancies: [{ code: 'quantity_mismatch', severity: 'critical' }] }, request, receivedConfirmed: true, acknowledgedDiscrepancies: ['quantity_mismatch'] });
  assert.equal(result.ok, false); assert.match(result.reason, /Critical/);
});
test('20 every warning must be acknowledged before finalization', () => {
  const result = canFinalize({ bill: { ...bill, discrepancies: [{ code: 'invoiceNumber_low_confidence', severity: 'warning' }] }, request, receivedConfirmed: true });
  assert.deepEqual(result.missingAcknowledgements, ['invoiceNumber_low_confidence']);
});
test('21 acknowledging a non-critical warning permits finalization', () => {
  const result = canFinalize({ bill: { ...bill, discrepancies: [{ code: 'supplier_history_mismatch', severity: 'warning' }] }, request, receivedConfirmed: true, acknowledgedDiscrepancies: ['supplier_history_mismatch'] });
  assert.equal(result.ok, true);
});
test('22 rejected, correction-required and superseded bills cannot be finalized', () => {
  for (const draft_status of ['rejected', 'correction_required', 'superseded']) assert.equal(finalize({ draft_status }).ok, false);
});
test('23 a verified bill cannot be received a second time', () => {
  assert.equal(finalize({ draft_status: 'verified', receipt_transaction_id: 'once' }).ok, false);
});
test('24 non-positive purchase quantity cannot be finalized', () => {
  assert.equal(finalize({ purchased_quantity: 0 }).ok, false);
});
