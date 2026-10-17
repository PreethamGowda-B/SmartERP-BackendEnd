'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateInvoice, roundMoney } = require('../services/invoiceMath');
const { normalizeGstr2b } = require('../services/gstr2bParser');

test('GST invoice tax split uses intra-state CGST and SGST and preserves the total', () => {
  const result = calculateInvoice({
    lineItems: [{ item_type: 'material', quantity: 2, unit_price: 500 }],
    discountAmount: 100,
    gstRate: 18,
    isInterState: false,
  });

  assert.equal(result.subtotal, 900);
  assert.equal(result.cgst, 81);
  assert.equal(result.sgst, 81);
  assert.equal(result.igst, 0);
  assert.equal(result.totalTax, result.cgst + result.sgst + result.igst);
  assert.equal(result.totalAmount, 1062);
});

test('GST invoice tax uses IGST for an inter-state supply', () => {
  const result = calculateInvoice({
    lineItems: [{ item_type: 'labour', quantity: 1, unit_price: 1000 }],
    gstRate: 18,
    isInterState: true,
  });

  assert.equal(result.cgst, 0);
  assert.equal(result.sgst, 0);
  assert.equal(result.igst, 180);
  assert.equal(result.totalAmount, 1180);
});

test('decimal-safe invoice arithmetic rounds each line and tax to paise', () => {
  const result = calculateInvoice({
    lineItems: [
      { item_type: 'material', quantity: 3, unit_price: 0.1 },
      { item_type: 'extra', quantity: 1, unit_price: 0.2 },
    ],
    gstRate: 18,
    isInterState: false,
  });

  assert.deepEqual(result.lineItems.map((item) => item.total_amount), [0.3, 0.2]);
  assert.equal(result.subtotal, 0.5);
  assert.equal(result.totalTax, 0.09);
  assert.equal(result.totalAmount, 0.59);
  assert.equal(roundMoney(1.005), 1.01);
});

test('GSTR-2B B2B parser aggregates line taxes and normalizes DD-MM-YYYY dates', () => {
  const invoices = normalizeGstr2b({
    data: { docdata: { b2b: [{
      ctin: '29ABCDE1234F1Z5',
      trdnm: 'Supplier One',
      inv: [{ inum: 'INV-42', idt: '17-10-2026', itms: [
        { num: 1, itm_det: { txval: 1000, camt: 90, samt: 90, iamt: 0 } },
        { num: 2, itm_det: { txval: 500, camt: 45, samt: 45, iamt: 0 } },
      ] }],
    }] } },
  });

  assert.equal(invoices.length, 1);
  assert.deepEqual(invoices[0], {
    supplierGstin: '29ABCDE1234F1Z5', supplierName: 'Supplier One', invoiceNumber: 'INV-42',
    invoiceDate: '2026-10-17', taxableValue: 1500, cgst: 135, sgst: 135, igst: 0, totalTax: 270,
  });
});

test('GSTR-2B parser rejects unsupported or empty statement structures', () => {
  assert.throws(() => normalizeGstr2b({ data: { docdata: { cdnr: [] } } }), /No supported B2B invoice rows/);
});
