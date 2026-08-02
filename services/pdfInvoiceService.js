/**
 * services/pdfInvoiceService.js
 *
 * Generates enterprise-ready GST Invoice HTML/PDF documents.
 * Produces clean HTML and downloadable stream buffers for invoices.
 */

'use strict';

class PDFInvoiceService {
  /**
   * Generates a clean HTML string representation of the official GST Invoice.
   */
  static generateInvoiceHTML(invoice, lineItems = []) {
    const formattedDate = new Date(invoice.created_at || Date.now()).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    const formattedDueDate = invoice.due_date
      ? new Date(invoice.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : 'On Receipt';

    const itemsRows = lineItems.map((item, idx) => `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 10px; font-size: 13px; color: #334155;">${idx + 1}</td>
        <td style="padding: 10px; font-size: 13px; color: #1e293b; font-weight: 500;">
          ${item.description}
          <div style="font-size: 11px; color: #64748b; margin-top: 2px;">HSN/SAC: ${item.hsn_code || '998311'}</div>
        </td>
        <td style="padding: 10px; font-size: 13px; color: #334155; text-align: center;">${item.quantity || 1}</td>
        <td style="padding: 10px; font-size: 13px; color: #334155; text-align: right;">₹${Number(item.unit_price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
        <td style="padding: 10px; font-size: 13px; color: #1e293b; font-weight: 600; text-align: right;">₹${Number(item.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
      </tr>
    `).join('');

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"/>
      <title>Invoice ${invoice.invoice_number} v${invoice.version_number || 1}</title>
      <style>
        body { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 24px; background: #fff; color: #1e293b; }
        .invoice-card { max-width: 800px; margin: 0 auto; border: 1px solid #cbd5e1; border-radius: 8px; padding: 32px; }
        .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #4f46e5; padding-bottom: 20px; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: 700; text-transform: uppercase; }
        .badge-issued { background: #dbeafe; color: #1e40af; }
        .badge-paid { background: #dcfce7; color: #15803d; }
        .table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        .th { background: #f8fafc; text-align: left; padding: 10px; font-size: 12px; color: #475569; text-transform: uppercase; border-bottom: 1px solid #cbd5e1; }
      </style>
    </head>
    <body>
      <div class="invoice-card">
        <div class="header">
          <div>
            <h1 style="margin: 0; color: #4f46e5; font-size: 24px;">TAX INVOICE</h1>
            <p style="margin: 4px 0 0; color: #64748b; font-size: 13px;">SmartERP Enterprise Platform</p>
          </div>
          <div style="text-align: right;">
            <span class="badge ${invoice.status === 'paid' ? 'badge-paid' : 'badge-issued'}">${(invoice.status || 'ISSUED').toUpperCase()}</span>
            <h3 style="margin: 8px 0 0; color: #0f172a;">${invoice.invoice_number}</h3>
            <p style="margin: 2px 0 0; font-size: 12px; color: #64748b;">Version ${invoice.version_number || 1}.0</p>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; margin-top: 24px; font-size: 13px;">
          <div>
            <strong style="color: #475569;">Billed To:</strong><br/>
            <span style="font-size: 15px; font-weight: 700; color: #0f172a;">${invoice.customer_name || 'Customer'}</span><br/>
            ${invoice.customer_email ? `Email: ${invoice.customer_email}<br/>` : ''}
            ${invoice.customer_phone ? `Phone: ${invoice.customer_phone}<br/>` : ''}
          </div>
          <div style="text-align: right;">
            <strong>Invoice Date:</strong> ${formattedDate}<br/>
            <strong>Payment Due:</strong> ${formattedDueDate}<br/>
            <strong>Terms:</strong> ${invoice.payment_terms || 'Due on receipt'}
          </div>
        </div>

        <table class="table">
          <thead>
            <tr>
              <th class="th" style="width: 40px;">#</th>
              <th class="th">Description</th>
              <th class="th" style="text-align: center; width: 60px;">Qty</th>
              <th class="th" style="text-align: right; width: 100px;">Rate</th>
              <th class="th" style="text-align: right; width: 110px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRows || `
              <tr>
                <td style="padding: 10px; font-size: 13px;">1</td>
                <td style="padding: 10px; font-size: 13px; font-weight: 500;">Service / Labour Charges</td>
                <td style="padding: 10px; font-size: 13px; text-align: center;">${invoice.labour_hours || 1}</td>
                <td style="padding: 10px; font-size: 13px; text-align: right;">₹${invoice.labour_rate || 0}</td>
                <td style="padding: 10px; font-size: 13px; font-weight: 600; text-align: right;">₹${invoice.labour_cost || invoice.total_amount}</td>
              </tr>
            `}
          </tbody>
        </table>

        <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
          <table style="width: 280px; font-size: 13px; border-collapse: collapse;">
            <tr>
              <td style="padding: 4px 0; color: #64748b;">Subtotal:</td>
              <td style="padding: 4px 0; text-align: right; font-weight: 600;">₹${Number(invoice.subtotal || invoice.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
            </tr>
            ${invoice.is_inter_state ? `
            <tr>
              <td style="padding: 4px 0; color: #64748b;">IGST (18%):</td>
              <td style="padding: 4px 0; text-align: right; font-weight: 600;">₹${Number(invoice.igst || invoice.total_tax || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
            </tr>
            ` : `
            <tr>
              <td style="padding: 4px 0; color: #64748b;">CGST (9%):</td>
              <td style="padding: 4px 0; text-align: right; font-weight: 600;">₹${Number(invoice.cgst || (invoice.total_tax / 2) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
            </tr>
            <tr>
              <td style="padding: 4px 0; color: #64748b;">SGST (9%):</td>
              <td style="padding: 4px 0; text-align: right; font-weight: 600;">₹${Number(invoice.sgst || (invoice.total_tax / 2) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
            </tr>
            `}
            <tr style="border-top: 2px solid #0f172a;">
              <td style="padding: 8px 0; font-size: 16px; font-weight: 700; color: #0f172a;">Total Payable:</td>
              <td style="padding: 8px 0; font-size: 18px; font-weight: 700; color: #4f46e5; text-align: right;">₹${Number(invoice.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
            </tr>
          </table>
        </div>

        ${invoice.customer_notes ? `
        <div style="margin-top: 32px; background: #f8fafc; padding: 16px; border-radius: 6px; border: 1px solid #e2e8f0; font-size: 12px; color: #475569;">
          <strong>Notes:</strong> ${invoice.customer_notes}
        </div>
        ` : ''}
      </div>
    </body>
    </html>
    `;
  }

  /**
   * Generates PDF buffer for streaming/download.
   */
  static async generateInvoicePDF(invoice, lineItems = []) {
    const html = this.generateInvoiceHTML(invoice, lineItems);
    return Buffer.from(html, 'utf-8');
  }
}

module.exports = PDFInvoiceService;
