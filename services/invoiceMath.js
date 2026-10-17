'use strict';

function rational(value) {
  const input = String(value ?? 0).trim();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(input);
  if (!match) throw new TypeError('Money values must be finite decimal numbers');
  const sign = match[1] === '-' ? -1n : 1n;
  const integer = match[2] || '0';
  const fraction = match[3] ?? match[4] ?? '';
  const exponent = Number(match[5] || 0);
  let numerator = sign * BigInt(`${integer}${fraction}` || '0');
  let scale = fraction.length - exponent;
  if (scale < 0) {
    numerator *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { numerator, denominator: 10n ** BigInt(scale) };
}

function roundRatio(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError('Denominator must be positive');
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return Number(negative ? -rounded : rounded);
}

const toCents = (value) => {
  const valueRatio = rational(value);
  return roundRatio(valueRatio.numerator * 100n, valueRatio.denominator);
};
const centsToMoney = (cents) => cents / 100;
const multiplyToCents = (left, right) => {
  const a = rational(left);
  const b = rational(right);
  return roundRatio(a.numerator * b.numerator * 100n, a.denominator * b.denominator);
};
const percentageToCents = (baseCents, percentage) => {
  const rate = rational(percentage);
  return roundRatio(BigInt(baseCents) * rate.numerator, rate.denominator * 100n);
};

const roundMoney = (value) => centsToMoney(toCents(value));

function calculateInvoice({ lineItems = [], labourHours = 0, labourRate = 0, equipmentCharges = 0, transportCharges = 0, additionalCharges = 0, discountAmount = 0, gstRate = 18, isInterState = false }) {
  if (!Array.isArray(lineItems)) throw new TypeError('Invoice line items must be an array');
  const items = lineItems.map((item) => {
    const quantity = Number(item.quantity ?? 1);
    const unitPrice = Number(item.unit_price ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error('Invoice line items require a positive quantity and a non-negative unit price');
    }
    return { ...item, quantity, unit_price: unitPrice, total_amount: centsToMoney(multiplyToCents(quantity, unitPrice)) };
  });

  const number = (value, name) => {
    const parsed = Number(value ?? 0);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
    return parsed;
  };
  const centsFor = (list) => list.reduce((sum, item) => sum + toCents(item.total_amount), 0);
  const rawItemsTotalCents = centsFor(items);
  const materialsCostCents = centsFor(items.filter((item) => item.item_type === 'material'));
  const labourCostCents = centsFor(items.filter((item) => ['labour', 'labor'].includes(String(item.item_type).toLowerCase())));
  const legacyLabourCostCents = labourCostCents === 0 && items.length === 0
    ? multiplyToCents(number(labourHours, 'Labour hours'), number(labourRate, 'Labour rate'))
    : labourCostCents;
  const itemsTotalCents = items.length ? rawItemsTotalCents : legacyLabourCostCents;
  const equipmentCents = toCents(number(equipmentCharges, 'Equipment charges'));
  const transportCents = toCents(number(transportCharges, 'Transport charges'));
  const additionalCents = toCents(number(additionalCharges, 'Additional charges'));
  const discountCents = toCents(number(discountAmount, 'Discount'));
  const gst = number(gstRate, 'GST rate');
  const subtotalCents = Math.max(0, itemsTotalCents + equipmentCents + transportCents + additionalCents - discountCents);
  const totalTaxCents = percentageToCents(subtotalCents, gst);
  const cgstCents = isInterState ? 0 : Math.round(totalTaxCents / 2);
  const sgstCents = isInterState ? 0 : totalTaxCents - cgstCents;
  const igstCents = isInterState ? totalTaxCents : 0;
  return {
    lineItems: items,
    itemsTotal: centsToMoney(itemsTotalCents),
    labourCost: centsToMoney(legacyLabourCostCents),
    materialsCost: centsToMoney(materialsCostCents),
    subtotal: centsToMoney(subtotalCents),
    gstRate: gst,
    totalTax: centsToMoney(totalTaxCents),
    cgst: centsToMoney(cgstCents),
    sgst: centsToMoney(sgstCents),
    igst: centsToMoney(igstCents),
    totalAmount: centsToMoney(subtotalCents + totalTaxCents),
  };
}

module.exports = { calculateInvoice, roundMoney };
