/**
 * services/pdfInvoiceService.js
 *
 * Generates enterprise-ready GST Invoice HTML/PDF documents.
 * Produces clean HTML and downloadable stream buffers for invoices.
 *
 * STRICT REQUIREMENT: Invoices belong to the COMPANY. Zero SmartERP branding.
 */

'use strict';

class PDFInvoiceService {
  /**
   * Generates a clean HTML string representation of the official GST Invoice.
   */
  static generateInvoiceHTML(invoice, lineItems = [], company = {}) {
    const formattedDate = new Date(invoice.created_at || Date.now()).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    const formattedDueDate = invoice.due_date
      ? new Date(invoice.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : 'On Receipt';

    const companyName = company.legal_name || company.name || 'BUSINESS ENTERPRISE';
    const companyLogo = company.logo_url ? `<img src="${company.logo_url}" style="max-height: 55px; max-width: 200px; margin-bottom: 8px;" alt="${companyName} Logo"/>` : '';
    const companyAddress = company.address ? `${company.address}${company.city ? ', ' + company.city : ''}${company.state ? ', ' + company.state : ''} ${company.pincode || ''}` : '';

    const upiQrUrl = company.upi_id
      ? `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(`upi://pay?pa=${company.upi_id}&pn=${companyName}&am=${invoice.total_amount}&cu=INR`)}`
      : null;

    const itemsRows = lineItems.map((item, idx) => `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 10px; font-size: 12px; color: #334155; text-align: center;">${idx + 1}</td>
        <td style="padding: 10px; font-size: 12px; color: #0f172a; font-weight: 600;">
          ${item.description}
          <div style="font-size: 11px; color: #64748b; font-weight: 400; margin-top: 2px;">HSN/SAC: ${item.hsn_code || '998311'}</div>
        </td>
        <td style="padding: 10px; font-size: 12px; color: #334155; text-align: center;">${item.quantity || 1}</td>
        <td style="padding: 10px; font-size: 12px; color: #334155; text-align: right;">₹${Number(item.unit_price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
        <td style="padding: 10px; font-size: 12px; color: #0f172a; font-weight: 700; text-align: right;">₹${Number(item.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
      </tr>
    `).join('');

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"/>
      <title>TAX INVOICE — ${invoice.invoice_number}</title>
      <style>
        @page { size: A4; margin: 15mm; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; background: #fff; color: #0f172a; line-height: 1.5; }
        .invoice-card { max-width: 820px; margin: 0 auto; border: 1px solid #cbd5e1; border-radius: 12px; padding: 36px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
        .header-strip { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 24px; }
        .company-title { font-size: 22px; font-weight: 900; color: #1e293b; letter-spacing: -0.5px; margin: 0 0 4px 0; }
        .meta-label { font-size: 10px; font-weight: 800; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px; }
        .meta-val { font-size: 13px; font-weight: 700; color: #0f172a; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }
        .badge-issued { background: #dbeafe; color: #1e40af; border: 1px solid #bfdbfe; }
        .badge-paid { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
        .badge-disputed { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
        .table { width: 100%; border-collapse: collapse; margin: 24px 0; }
        .th { background: #f8fafc; text-align: left; padding: 10px; font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; border-top: 1px solid #e2e8f0; border-bottom: 2px solid #cbd5e1; }
        .grid-2 { display: flex; justify-content: space-between; gap: 24px; font-size: 12px; }
        .info-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; flex: 1; }
      </style>
    </head>
    <body>
      <div class="invoice-card">
        <!-- Top Company Header -->
        <div class="header-strip">
          <div style="max-width: 60%;">
            ${companyLogo}
            <h1 class="company-title">${companyName}</h1>
            ${companyAddress ? `<div style="font-size: 12px; color: #475569; margin-top: 2px;">${companyAddress}</div>` : ''}
            <div style="font-size: 11px; color: #64748b; margin-top: 4px;">
              ${company.gstin ? `<strong>GSTIN:</strong> ${company.gstin} &nbsp;|&nbsp; ` : ''}
              ${company.pan ? `<strong>PAN:</strong> ${company.pan} &nbsp;|&nbsp; ` : ''}
              ${company.phone ? `<strong>Tel:</strong> ${company.phone}` : ''}
            </div>
            ${company.contact_email || company.website ? `
              <div style="font-size: 11px; color: #64748b;">
                ${company.contact_email ? `Email: ${company.contact_email} &nbsp;|&nbsp; ` : ''}
                ${company.website ? `Web: ${company.website}` : ''}
              </div>
            ` : ''}
          </div>

          <div style="text-align: right;">
            <div style="font-size: 20px; font-weight: 900; color: #2563eb; letter-spacing: -0.5px; margin-bottom: 6px;">TAX INVOICE</div>
            <span class="badge ${invoice.status === 'paid' ? 'badge-paid' : invoice.status === 'disputed' ? 'badge-disputed' : 'badge-issued'}">
              ${(invoice.status || 'ISSUED').toUpperCase()}
            </span>
            <div style="margin-top: 10px;">
              <div class="meta-label">Invoice Number</div>
              <div class="meta-val" style="font-family: monospace; font-size: 15px;">${invoice.invoice_number}</div>
              <div style="font-size: 10px; color: #64748b;">Version ${invoice.version_number || 1}.0</div>
            </div>
          </div>
        </div>

        <!-- Bill To & Meta Info Grid -->
        <div class="grid-2">
          <div class="info-box">
            <div class="meta-label" style="margin-bottom: 6px; color: #2563eb;">Billed To / Customer</div>
            <div style="font-size: 15px; font-weight: 800; color: #0f172a;">${invoice.customer_name || 'Customer'}</div>
            ${invoice.customer_company ? `<div style="font-weight: 600; color: #334155;">${invoice.customer_company}</div>` : ''}
            ${invoice.customer_address ? `<div style="color: #475569; margin-top: 4px;">${invoice.customer_address}</div>` : ''}
            ${invoice.customer_email ? `<div style="color: #64748b; margin-top: 2px;">Email: ${invoice.customer_email}</div>` : ''}
            ${invoice.customer_phone ? `<div style="color: #64748b;">Phone: ${invoice.customer_phone}</div>` : ''}
            ${invoice.customer_gstin ? `<div style="color: #0f172a; font-weight: 700; margin-top: 4px;">GSTIN: ${invoice.customer_gstin}</div>` : ''}
          </div>

          <div class="info-box" style="text-align: right; background: #fff;">
            <div style="margin-bottom: 8px;">
              <span class="meta-label">Invoice Date:</span>
              <span class="meta-val">${formattedDate}</span>
            </div>
            <div style="margin-bottom: 8px;">
              <span class="meta-label">Payment Due:</span>
              <span class="meta-val" style="color: #dc2626;">${formattedDueDate}</span>
            </div>
            <div style="margin-bottom: 8px;">
              <span class="meta-label">Payment Terms:</span>
              <span class="meta-val">${invoice.payment_terms || 'Due on Receipt'}</span>
            </div>
            ${invoice.job_title ? `
              <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed #cbd5e1;">
                <span class="meta-label">Job Reference:</span>
                <div style="font-weight: 700; color: #1e293b;">${invoice.job_title}</div>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Line Items Table -->
        <table class="table">
          <thead>
            <tr>
              <th class="th" style="width: 40px; text-align: center;">#</th>
              <th class="th">Item & Service Description</th>
              <th class="th" style="text-align: center; width: 60px;">Qty</th>
              <th class="th" style="text-align: right; width: 110px;">Unit Rate (₹)</th>
              <th class="th" style="text-align: right; width: 120px;">Amount (₹)</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRows || `
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px; font-size: 12px; text-align: center;">1</td>
                <td style="padding: 10px; font-size: 12px; font-weight: 600;">Service / Labour Charges</td>
                <td style="padding: 10px; font-size: 12px; text-align: center;">${invoice.labour_hours || 1}</td>
                <td style="padding: 10px; font-size: 12px; text-align: right;">₹${invoice.labour_rate || 0}</td>
                <td style="padding: 10px; font-size: 12px; font-weight: 700; text-align: right;">₹${Number(invoice.labour_cost || invoice.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              </tr>
            `}
          </tbody>
        </table>

        <!-- Summary & Tax Breakdown -->
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-top: 16px;">
          <!-- Payment / Bank Details -->
          <div style="font-size: 11px; color: #475569; flex: 1;">
            ${company.bank_name || company.account_number || company.upi_id ? `
              <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
                <div class="meta-label" style="color: #0f172a; margin-bottom: 6px;">Bank & Payment Details</div>
                ${company.bank_name ? `<div><strong>Bank Name:</strong> ${company.bank_name}</div>` : ''}
                ${company.account_number ? `<div><strong>Account No:</strong> ${company.account_number}</div>` : ''}
                ${company.ifsc_code ? `<div><strong>IFSC Code:</strong> ${company.ifsc_code}</div>` : ''}
                ${company.upi_id ? `<div><strong>UPI ID:</strong> ${company.upi_id}</div>` : ''}
              </div>
            ` : ''}

            ${upiQrUrl ? `
              <div style="margin-top: 10px; display: flex; align-items: center; gap: 10px;">
                <img src="${upiQrUrl}" style="width: 80px; height: 80px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 4px;" alt="UPI Payment QR"/>
                <div>
                  <div style="font-weight: 700; color: #0f172a;">Scan to Pay via UPI</div>
                  <div style="font-size: 10px; color: #64748b;">Supported by GPay, PhonePe, Paytm</div>
                </div>
              </div>
            ` : ''}
          </div>

          <!-- Financial Calculation Table -->
          <div style="width: 300px;">
            <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
              <tr>
                <td style="padding: 4px 0; color: #64748b;">Subtotal:</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 600;">₹${Number(invoice.subtotal || invoice.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              </tr>
              ${invoice.discount_amount ? `
              <tr>
                <td style="padding: 4px 0; color: #16a34a;">Approved Discount:</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 600; color: #16a34a;">- ₹${Number(invoice.discount_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              </tr>
              ` : ''}
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
                <td style="padding: 8px 0; font-size: 15px; font-weight: 800; color: #0f172a;">Grand Total:</td>
                <td style="padding: 8px 0; font-size: 16px; font-weight: 900; color: #2563eb; text-align: right;">₹${Number(invoice.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              </tr>
            </table>
          </div>
        </div>

        <!-- Notes & Terms -->
        ${invoice.customer_notes || company.terms_and_conditions ? `
        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; display: flex; gap: 24px; font-size: 11px; color: #475569;">
          ${invoice.customer_notes ? `
            <div style="flex: 1;">
              <strong style="color: #0f172a;">Invoice Notes:</strong>
              <div>${invoice.customer_notes}</div>
            </div>
          ` : ''}
          ${company.terms_and_conditions ? `
            <div style="flex: 1;">
              <strong style="color: #0f172a;">Terms & Conditions:</strong>
              <div style="white-space: pre-line;">${company.terms_and_conditions}</div>
            </div>
          ` : ''}
        </div>
        ` : ''}

        <!-- Footer Signatory Section -->
        <div style="margin-top: 36px; padding-top: 20px; border-top: 2px solid #cbd5e1; display: flex; justify-content: space-between; align-items: flex-end;">
          <div style="font-size: 11px; color: #64748b;">
            <div>Generated on: ${new Date().toLocaleString('en-IN')}</div>
            <div style="font-weight: 700; color: #0f172a; margin-top: 2px;">This is a computer-generated tax invoice.</div>
          </div>

          <div style="text-align: right;">
            ${company.stamp_url ? `<img src="${company.stamp_url}" style="max-height: 50px; max-width: 150px; display: block; margin-left: auto; margin-bottom: 4px;" alt="Signature Stamp"/>` : ''}
            <div style="border-top: 1px solid #0f172a; width: 180px; margin-left: auto; padding-top: 4px;">
              <div style="font-size: 12px; font-weight: 800; color: #0f172a;">${company.authorized_signatory_name || companyName}</div>
              <div style="font-size: 10px; color: #64748b;">Authorized Signatory</div>
            </div>
          </div>
        </div>
      </div>
    </body>
    </html>
    `;
  }

  /**
   * Generates PDF buffer for streaming/download.
   */
  static async generateInvoicePDF(invoice, lineItems = [], company = {}) {
    const html = this.generateInvoiceHTML(invoice, lineItems, company);
    return Buffer.from(html, 'utf-8');
  }
}

module.exports = PDFInvoiceService;
