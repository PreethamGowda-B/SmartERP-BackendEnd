'use strict';

const { randomUUID } = require('crypto');
const invoiceService = require('./invoiceService');

/**
 * Backward-compatible GST invoice facade. All persistence, tax math, numbering,
 * line items, and AR/PDF references are handled by the canonical invoice service.
 */
class GSTInvoiceService {
  static async generateGSTInvoice({ companyId, customerName, customerGstin = '', items = [], isInterState = false, userId = null, idempotencyKey = randomUUID() }) {
    if (!companyId || !customerName || !Array.isArray(items) || !items.length) {
      throw new Error('Company ID, customer name, and at least one line item are required.');
    }
    const result = await invoiceService.createDirectInvoice({
      companyId,
      userId,
      invoiceData: {
        customer_name: customerName,
        customer_gstin: customerGstin,
        lineItems: items.map((item) => ({
          item_type: item.item_type || 'service',
          description: item.description || 'Service / Item',
          hsn_code: item.hsnCode || item.hsn_code || '998311',
          quantity: item.quantity ?? 1,
          unit_price: item.unitPrice ?? item.unit_price ?? 0,
        })),
        gst_rate: 18,
        is_inter_state: isInterState,
        due_days: 15,
        payment_status: 'unpaid',
        invoice_type: 'gst',
        idempotency_key: idempotencyKey,
      },
    });
    const invoice = result.invoice;
    return {
      success: true,
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
        customerName: invoice.customer_name,
        customerGstin: invoice.customer_gstin,
        createdDate: new Date(invoice.created_at).toISOString().slice(0, 10),
        dueDate: invoice.due_date,
        isInterState: Boolean(invoice.is_inter_state),
        subtotal: Number(invoice.subtotal).toFixed(2),
        cgst: Number(invoice.cgst).toFixed(2),
        sgst: Number(invoice.sgst).toFixed(2),
        igst: Number(invoice.igst).toFixed(2),
        totalTax: Number(invoice.total_tax).toFixed(2),
        grandTotal: Number(invoice.total_amount).toFixed(2),
        currency: 'INR (₹)',
        lineItems: result.lineItems,
      },
    };
  }
}

module.exports = GSTInvoiceService;
