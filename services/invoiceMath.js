'use strict';

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function calculateInvoice({ lineItems = [], labourHours = 0, labourRate = 0, equipmentCharges = 0, transportCharges = 0, additionalCharges = 0, discountAmount = 0, gstRate = 18, isInterState = false }) {
  if (!Array.isArray(lineItems)) throw new TypeError('Invoice line items must be an array');
  const items = lineItems.map((item) => {
    const quantity = Number(item.quantity ?? 1);
    const unitPrice = Number(item.unit_price ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error('Invoice line items require a positive quantity and a non-negative unit price');
    }
    return { ...item, quantity, unit_price: unitPrice, total_amount: roundMoney(quantity * unitPrice) };
  });

  const number = (value, name) => {
    const parsed = Number(value ?? 0);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
    return parsed;
  };
  const rawItemsTotal = roundMoney(items.reduce((sum, item) => sum + item.total_amount, 0));
  const materialsCost = roundMoney(items.filter((item) => item.item_type === 'material').reduce((sum, item) => sum + item.total_amount, 0));
  const labourCost = roundMoney(items.filter((item) => ['labour', 'labor'].includes(String(item.item_type).toLowerCase())).reduce((sum, item) => sum + item.total_amount, 0));
  const legacyLabourCost = labourCost === 0 && items.length === 0 ? roundMoney(number(labourHours, 'Labour hours') * number(labourRate, 'Labour rate')) : labourCost;
  const itemsTotal = items.length ? rawItemsTotal : legacyLabourCost;
  const equipment = number(equipmentCharges, 'Equipment charges');
  const transport = number(transportCharges, 'Transport charges');
  const additional = number(additionalCharges, 'Additional charges');
  const discount = number(discountAmount, 'Discount');
  const gst = number(gstRate, 'GST rate');
  const subtotal = roundMoney(Math.max(0, itemsTotal + equipment + transport + additional - discount));
  const totalTax = roundMoney(subtotal * gst / 100);
  const cgst = isInterState ? 0 : roundMoney(totalTax / 2);
  const sgst = isInterState ? 0 : roundMoney(totalTax - cgst);
  const igst = isInterState ? totalTax : 0;
  return { lineItems: items, itemsTotal, labourCost: legacyLabourCost, materialsCost, subtotal, gstRate: gst, totalTax, cgst, sgst, igst, totalAmount: roundMoney(subtotal + totalTax) };
}

module.exports = { calculateInvoice, roundMoney };
