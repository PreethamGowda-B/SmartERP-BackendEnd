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
    // Keep the downloadable artifact self-contained: the owner preview and customer
    // download both represent this same invoice data, but PDF rendering must work in
    // production without a browser or a third-party PDF service.
    const safe = (value) => String(value ?? '')
      .replace(/₹/g, 'INR ')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/[\\()]/g, '\\$&');
    const money = (value) => `INR ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const date = (value) => new Date(value || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const companyName = company.legal_name || company.name || 'BUSINESS ENTERPRISE';
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const margin = 42;
    const pageContents = [];
    let ops = [];
    let y = margin;
    const rgb = (hex) => {
      const normalized = hex.replace('#', '');
      return [0, 2, 4].map((offset) => (parseInt(normalized.slice(offset, offset + 2), 16) / 255).toFixed(3)).join(' ');
    };
    const rect = (x, top, width, height, color, stroke = null) => {
      const fill = rgb(color);
      ops.push(`${fill} rg ${x} ${pageHeight - top - height} ${width} ${height} re f`);
      if (stroke) ops.push(`${rgb(stroke)} RG 0.7 w ${x} ${pageHeight - top - height} ${width} ${height} re S`);
    };
    const line = (x1, top1, x2, top2, color = '#e2e8f0', width = 1) => {
      ops.push(`${rgb(color)} RG ${width} w ${x1} ${pageHeight - top1} m ${x2} ${pageHeight - top2} l S`);
    };
    const text = (value, x, top, size = 10, color = '#334155', bold = false) => {
      ops.push(`${rgb(color)} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x} ${pageHeight - top - size} Tm (${safe(value)}) Tj ET`);
    };
    const rightText = (value, right, top, size = 10, color = '#334155', bold = false) => {
      const safeValue = safe(value);
      const estimatedWidth = safeValue.length * size * (bold ? 0.55 : 0.5);
      text(value, right - estimatedWidth, top, size, color, bold);
    };
    const wrap = (value, maxChars) => {
      const words = String(value || '').split(/\s+/);
      const rows = [];
      let current = '';
      for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (next.length > maxChars && current) { rows.push(current); current = word; }
        else current = next;
      }
      if (current) rows.push(current);
      return rows.length ? rows : [''];
    };
    const finishPage = () => { pageContents.push(Buffer.from(ops.join('\n'), 'ascii')); ops = []; };
    const startContinuationPage = () => {
      finishPage();
      y = margin;
      text(companyName, margin, y, 12, '#0f172a', true);
      rightText(`TAX INVOICE  |  ${invoice.invoice_number || ''}`, pageWidth - margin, y + 1, 9, '#2563eb', true);
      y += 24;
      line(margin, y, pageWidth - margin, y, '#cbd5e1', 1.2);
      y += 15;
      rect(margin, y, pageWidth - margin * 2, 24, '#f1f5f9');
      text('Item & Service Description', margin + 10, y + 7, 8, '#475569', true);
      rightText('QTY', 395, y + 7, 8, '#475569', true);
      rightText('UNIT RATE', 480, y + 7, 8, '#475569', true);
      rightText('AMOUNT', pageWidth - margin - 10, y + 7, 8, '#475569', true);
      y += 32;
    };

    // Company and invoice header.
    rect(0, 0, pageWidth, 10, '#2563eb');
    text(companyName, margin, y, 19, '#0f172a', true);
    y += 27;
    for (const detail of [
      company.address ? `${company.address}${company.city ? `, ${company.city}` : ''}${company.state ? `, ${company.state}` : ''}${company.pincode ? ` ${company.pincode}` : ''}` : '',
      [company.gstin ? `GSTIN: ${company.gstin}` : '', company.pan ? `PAN: ${company.pan}` : ''].filter(Boolean).join('  |  '),
      [company.phone ? `Phone: ${company.phone}` : '', company.contact_email || ''].filter(Boolean).join('  |  '),
    ].filter(Boolean)) {
      text(detail, margin, y, 8.5, '#64748b');
      y += 13;
    }
    const invoiceRight = pageWidth - margin;
    text('TAX INVOICE', invoiceRight - 126, margin - 2, 17, '#2563eb', true);
    text(`Invoice: ${invoice.invoice_number || ''}`, invoiceRight - 126, margin + 23, 10, '#0f172a', true);
    text(`STATUS: ${(invoice.status || 'ISSUED').toUpperCase()}`, invoiceRight - 126, margin + 40, 8, invoice.status === 'paid' ? '#15803d' : '#b45309', true);
    y += 3;
    line(margin, y, invoiceRight, y, '#2563eb', 2);
    y += 18;

    // Billed-to and invoice metadata cards.
    const cardTop = y;
    rect(margin, cardTop, 300, 105, '#f8fafc', '#e2e8f0');
    rect(margin + 314, cardTop, pageWidth - margin * 2 - 314, 105, '#ffffff', '#e2e8f0');
    text('BILLED TO', margin + 12, cardTop + 11, 8, '#2563eb', true);
    text(invoice.customer_name || 'Customer', margin + 12, cardTop + 27, 12, '#0f172a', true);
    let customerY = cardTop + 45;
    for (const detail of [invoice.customer_company, invoice.customer_address, invoice.customer_email, invoice.customer_phone && `Phone: ${invoice.customer_phone}`, invoice.customer_gstin && `GSTIN: ${invoice.customer_gstin}`].filter(Boolean)) {
      for (const row of wrap(detail, 49).slice(0, 2)) { text(row, margin + 12, customerY, 8, '#64748b'); customerY += 11; }
      if (customerY > cardTop + 91) break;
    }
    const metaX = margin + 326;
    text('INVOICE DATE', metaX, cardTop + 12, 7.5, '#64748b', true);
    text(date(invoice.created_at), metaX, cardTop + 24, 9, '#0f172a', true);
    text('PAYMENT DUE', metaX, cardTop + 47, 7.5, '#64748b', true);
    text(invoice.due_date ? date(invoice.due_date) : 'On Receipt', metaX, cardTop + 59, 9, '#0f172a', true);
    if (invoice.job_title) {
      text('JOB REFERENCE', metaX, cardTop + 80, 7.5, '#64748b', true);
      text(wrap(invoice.job_title, 31)[0], metaX, cardTop + 91, 8, '#0f172a', true);
    }
    y = cardTop + 123;

    // Line items with row wrapping and page continuation.
    const tableX = margin;
    const tableWidth = pageWidth - margin * 2;
    const columns = { description: tableX + 12, qty: tableX + 374, rate: tableX + 465, amount: tableX + tableWidth - 12 };
    rect(tableX, y, tableWidth, 27, '#eff6ff');
    text('ITEM & SERVICE DESCRIPTION', columns.description, y + 9, 7.5, '#475569', true);
    rightText('QTY', columns.qty, y + 9, 7.5, '#475569', true);
    rightText('UNIT RATE', columns.rate, y + 9, 7.5, '#475569', true);
    rightText('AMOUNT', columns.amount, y + 9, 7.5, '#475569', true);
    y += 27;
    const rows = lineItems.length ? lineItems : [{ description: 'Service / Labour Charges', quantity: invoice.labour_hours || 1, unit_price: invoice.labour_rate || 0, total_amount: invoice.labour_cost || invoice.total_amount || 0 }];
    for (const [index, item] of rows.entries()) {
      const descriptionRows = wrap(item.description || 'Invoice item', 53);
      const hsnRows = item.hsn_code ? [`HSN/SAC: ${item.hsn_code}`] : [];
      const rowHeight = Math.max(38, (descriptionRows.length + hsnRows.length) * 11 + 17);
      if (y + rowHeight > pageHeight - 230) startContinuationPage();
      if (index % 2 === 1) rect(tableX, y, tableWidth, rowHeight, '#fafcff');
      descriptionRows.forEach((row, rowIndex) => text(row, columns.description, y + 9 + rowIndex * 11, 8.5, '#0f172a', rowIndex === 0));
      hsnRows.forEach((row, rowIndex) => text(row, columns.description, y + 10 + (descriptionRows.length + rowIndex) * 11, 7, '#64748b'));
      rightText(Number(item.quantity || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }), columns.qty, y + 10, 8, '#334155');
      rightText(money(item.unit_price), columns.rate, y + 10, 8, '#334155');
      rightText(money(item.total_amount), columns.amount, y + 10, 8, '#0f172a', true);
      y += rowHeight;
      line(tableX, y, tableX + tableWidth, y, '#e2e8f0', 0.6);
    }
    y += 16;

    // Payment/bank information and a clear total panel.
    const summaryTop = y;
    const summaryX = pageWidth - margin - 230;
    const summaryRows = [
      ['Subtotal', money(invoice.subtotal ?? invoice.total_amount)],
      ...(Number(invoice.discount_amount) ? [['Discount', `- ${money(invoice.discount_amount)}`]] : []),
      ...(invoice.is_inter_state
        ? [['IGST', money(invoice.igst ?? invoice.total_tax)]]
        : [['CGST', money(invoice.cgst ?? (Number(invoice.total_tax || 0) / 2))], ['SGST', money(invoice.sgst ?? (Number(invoice.total_tax || 0) / 2))]]),
    ];
    const bankRows = [
      company.bank_name && `Bank: ${company.bank_name}`,
      company.account_number && `Account: ${company.account_number}`,
      company.ifsc_code && `IFSC: ${company.ifsc_code}`,
      company.upi_id && `UPI: ${company.upi_id}`,
    ].filter(Boolean);
    if (bankRows.length) {
      text('PAYMENT DETAILS', margin, summaryTop, 8, '#475569', true);
      bankRows.forEach((row, index) => text(row, margin, summaryTop + 16 + index * 13, 8, '#64748b'));
    }
    summaryRows.forEach(([label, value], index) => {
      text(label, summaryX, summaryTop + index * 18, 8.5, '#64748b');
      rightText(value, pageWidth - margin, summaryTop + index * 18, 8.5, '#334155', true);
    });
    const totalTop = summaryTop + summaryRows.length * 18 + 3;
    rect(summaryX - 8, totalTop, 238, 34, '#eff6ff', '#bfdbfe');
    text('GRAND TOTAL', summaryX, totalTop + 11, 9, '#1e3a8a', true);
    rightText(money(invoice.total_amount), pageWidth - margin - 8, totalTop + 8, 12, '#1d4ed8', true);
    text(`Paid ${money(invoice.amount_paid)}    Balance due ${money(invoice.amount_due ?? invoice.total_amount)}`, summaryX, totalTop + 43, 8, '#475569', true);
    y = Math.max(totalTop + 60, summaryTop + (bankRows.length ? 20 + bankRows.length * 13 : 0));
    if (invoice.customer_notes || company.terms_and_conditions) {
      y += 10;
      line(margin, y, pageWidth - margin, y);
      y += 12;
      const note = invoice.customer_notes || 'Thank you for your business.';
      text('NOTES', margin, y, 7.5, '#475569', true);
      wrap(note, 100).slice(0, 3).forEach((row, index) => text(row, margin, y + 12 + index * 11, 8, '#64748b'));
      y += 47;
    }
    const footerY = Math.min(Math.max(y + 10, pageHeight - 65), pageHeight - 44);
    line(margin, footerY, pageWidth - margin, footerY, '#cbd5e1', 1);
    text('This is a computer-generated tax invoice.', margin, footerY + 10, 7.5, '#64748b');
    rightText(company.authorized_signatory_name ? `For ${company.authorized_signatory_name}` : `For ${companyName}`, pageWidth - margin, footerY + 10, 8, '#334155', true);
    finishPage();

    const objects = [];
    const pageIds = pageContents.map((_, index) => 5 + index * 2);
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
    pageContents.forEach((content, index) => {
      const pageId = pageIds[index];
      const contentId = pageId + 1;
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
      objects[contentId] = { stream: content };
    });
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (let id = 1; id < objects.length; id += 1) {
      offsets[id] = Buffer.byteLength(pdf, 'ascii');
      const object = objects[id];
      if (object && typeof object === 'object' && object.stream) {
        pdf += `${id} 0 obj\n<< /Length ${object.stream.length} >>\nstream\n${object.stream.toString('ascii')}\nendstream\nendobj\n`;
      } else {
        pdf += `${id} 0 obj\n${object}\nendobj\n`;
      }
    }
    const xrefOffset = Buffer.byteLength(pdf, 'ascii');
    pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(pdf, 'ascii');
  }
}

module.exports = PDFInvoiceService;
