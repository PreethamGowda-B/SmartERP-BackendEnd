const test = require('node:test');
const assert = require('node:assert/strict');
const GstReconciliationService = require('../services/gstReconciliationService');
const InventoryForecastService = require('../services/inventoryForecastService');

test.describe('GST Confidence Scoring & Inventory Math Engine Edge-Case Vectors', () => {

  // -----------------------------------------------------------------
  // 1. GST Confidence Scoring Matrix (10 Edge Cases)
  // -----------------------------------------------------------------
  test('GST-1: Exact invoice match, exact tax & date (Should yield 100% score)', () => {
    const res = GstReconciliationService.calculateConfidenceScore({
      booksItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-101', taxableValue: 1000, totalTax: 180, invoiceDate: '2026-07-01' },
      portalItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-101', taxableValue: 1000, totalTax: 180, invoiceDate: '2026-07-01' }
    });
    assert.equal(res.score, 100.00);
    assert.equal(res.matchStatus, 'exact_match');
  });

  test('GST-2: GSTIN Mismatch must force score to 0.00%', () => {
    const res = GstReconciliationService.calculateConfidenceScore({
      booksItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-101', taxableValue: 1000 },
      portalItem: { supplierGstin: '29BBBBB1111B2Z6', invoiceNumber: 'INV-101', taxableValue: 1000 }
    });
    assert.equal(res.score, 0.00);
    assert.equal(res.matchStatus, 'missing_in_gstr');
  });

  test('GST-3: Exact ₹4.00 value variance tolerance boundary (Should yield fuzzy_match within tolerance)', () => {
    const res = GstReconciliationService.calculateConfidenceScore({
      booksItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-101', taxableValue: 1000, totalTax: 180, invoiceDate: '2026-07-01' },
      portalItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-101', taxableValue: 1004, totalTax: 180, invoiceDate: '2026-07-01' }
    });
    assert.ok(res.score >= 95.00);
    assert.equal(res.matchStatus, 'fuzzy_match');
  });

  test('GST-4: Value variance > ₹5.00 should penalize score and produce tax_mismatch', () => {
    const res = GstReconciliationService.calculateConfidenceScore({
      booksItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-101', taxableValue: 1000, totalTax: 180 },
      portalItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-101', taxableValue: 1500, totalTax: 270 }
    });
    assert.ok(res.score < 90.00);
    assert.equal(res.matchStatus, 'tax_mismatch');
  });

  test('GST-5: Invoice number with leading zeros and special characters normalized', () => {
    const norm1 = GstReconciliationService.normalizeInvoiceNumber('00INV/2026-01');
    const norm2 = GstReconciliationService.normalizeInvoiceNumber('INV202601');
    assert.equal(norm1, 'INV202601');
    assert.equal(norm2, 'INV202601');
  });

  test('GST-6: Zero value invoice amounts handled safely', () => {
    const res = GstReconciliationService.calculateConfidenceScore({
      booksItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-0', taxableValue: 0, totalTax: 0 },
      portalItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-0', taxableValue: 0, totalTax: 0 }
    });
    assert.equal(res.score, 100.00);
  });

  test('GST-7: Empty GSTIN returns 0.00%', () => {
    const res = GstReconciliationService.calculateConfidenceScore({
      booksItem: { supplierGstin: '', invoiceNumber: 'INV-1' },
      portalItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-1' }
    });
    assert.equal(res.score, 0.00);
  });

  test('GST-8: Date gap of 60+ days reduces date proximity score to 0', () => {
    const resClose = GstReconciliationService.calculateConfidenceScore({
      booksItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-1', taxableValue: 100, totalTax: 18, invoiceDate: '2026-07-01' },
      portalItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-1', taxableValue: 100, totalTax: 18, invoiceDate: '2026-07-02' }
    });
    const resFar = GstReconciliationService.calculateConfidenceScore({
      booksItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-1', taxableValue: 100, totalTax: 18, invoiceDate: '2026-07-01' },
      portalItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-1', taxableValue: 100, totalTax: 18, invoiceDate: '2026-09-15' }
    });
    assert.ok(resClose.score > resFar.score);
  });

  test('GST-9: Levenshtein ratio returns 1.0 for exact string match', () => {
    const ratio = GstReconciliationService.computeLevenshteinRatio('INV-101', '00INV-101');
    assert.equal(ratio, 1.0);
  });

  test('GST-10: Tax mismatch classification when tax delta exceeds tolerance', () => {
    const res = GstReconciliationService.calculateConfidenceScore({
      booksItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-101', taxableValue: 1000, totalTax: 180 },
      portalItem: { supplierGstin: '27AAAAA0000A1Z5', invoiceNumber: 'INV-101', taxableValue: 1000, totalTax: 250 }
    });
    assert.equal(res.matchStatus, 'tax_mismatch');
  });

  // -----------------------------------------------------------------
  // 2. Inventory EOQ & ROP Math Engine (10 Edge Cases)
  // -----------------------------------------------------------------
  test('INV-1: Standard EOQ calculation (D=3650, S=500, H=50 => EOQ=271)', () => {
    const eoq = InventoryForecastService.calculateEOQ({ annualDemand: 3650, orderCost: 500, annualHoldingCostPerUnit: 50 });
    assert.equal(eoq, 271);
  });

  test('INV-2: Zero annual demand returns default fallback 10', () => {
    const eoq = InventoryForecastService.calculateEOQ({ annualDemand: 0 });
    assert.equal(eoq, 10);
  });

  test('INV-3: Negative annual demand handled safely', () => {
    const eoq = InventoryForecastService.calculateEOQ({ annualDemand: -500 });
    assert.equal(eoq, 10);
  });

  test('INV-4: High demand scaling (D=10,000,000)', () => {
    const eoq = InventoryForecastService.calculateEOQ({ annualDemand: 10000000, orderCost: 500, annualHoldingCostPerUnit: 50 });
    assert.equal(eoq, 14143);
  });

  test('INV-5: ROP calculation for daily rate 10, lead time 7 days', () => {
    const res = InventoryForecastService.calculateROP({ dailyUsageRate: 10, leadTimeDays: 7, serviceLevelFactor: 1.65 });
    assert.equal(res.dailyUsageRate, 10);
    assert.ok(res.safetyStock > 0);
    assert.ok(res.reorderPoint > 70);
  });

  test('INV-6: ROP calculation with zero daily rate returns zero safety stock & ROP', () => {
    const res = InventoryForecastService.calculateROP({ dailyUsageRate: 0, leadTimeDays: 7 });
    assert.equal(res.dailyUsageRate, 0);
    assert.equal(res.safetyStock, 0);
    assert.equal(res.reorderPoint, 0);
  });

  test('INV-7: Negative daily usage rate coerced to 0', () => {
    const res = InventoryForecastService.calculateROP({ dailyUsageRate: -15, leadTimeDays: 7 });
    assert.equal(res.dailyUsageRate, 0);
    assert.equal(res.reorderPoint, 0);
  });

  test('INV-8: ROP with 0 lead time days returns 0 safety stock', () => {
    const res = InventoryForecastService.calculateROP({ dailyUsageRate: 10, leadTimeDays: 0 });
    assert.equal(res.safetyStock, 0);
    assert.equal(res.reorderPoint, 0);
  });

  test('INV-9: Fractional daily rate (e.g. 0.33) rounds ROP up', () => {
    const res = InventoryForecastService.calculateROP({ dailyUsageRate: 0.33, leadTimeDays: 14 });
    assert.ok(res.reorderPoint >= 5);
  });

  test('INV-10: String inputs for daily usage rate parsed correctly', () => {
    const res = InventoryForecastService.calculateROP({ dailyUsageRate: "12.5", leadTimeDays: 5 });
    assert.equal(res.dailyUsageRate, 12.5);
  });

});
