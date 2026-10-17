'use strict';

function amount(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('GSTR-2B amounts must be finite and non-negative.');
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function invoiceDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const dmy = /^(\d{2})[-/]([A-Za-z0-9]{2,3}|\d{2})[-/](\d{4})$/.exec(text);
  if (dmy) {
    const month = /^\d+$/.test(dmy[2]) ? dmy[2].padStart(2, '0') : ({ JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }[dmy[2].toUpperCase()]);
    if (!month) return null;
    return `${dmy[3]}-${month}-${dmy[1]}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return iso ? text : null;
}

function normalizeGstr2b(raw) {
  const root = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('Upload a valid GSTR-2B JSON object.');

  // Also accept already normalized rows for integrations that prepare them upstream.
  if (Array.isArray(root.invoices)) {
    return root.invoices.map((row) => ({
      supplierGstin: String(row.supplierGstin || row.gstin || '').trim().toUpperCase(),
      supplierName: row.supplierName || row.tradeName || null,
      invoiceNumber: String(row.invoiceNumber || row.invoice_number || '').trim(),
      invoiceDate: invoiceDate(row.invoiceDate || row.invoice_date),
      taxableValue: amount(row.taxableValue ?? row.taxable_value),
      cgst: amount(row.cgst ?? 0),
      sgst: amount(row.sgst ?? 0),
      igst: amount(row.igst ?? 0),
      totalTax: amount(row.totalTax ?? row.total_tax ?? (Number(row.cgst || 0) + Number(row.sgst || 0) + Number(row.igst || 0))),
    })).filter((row) => row.supplierGstin && row.invoiceNumber);
  }

  const docdata = root.data?.docdata || root.docdata;
  const suppliers = Array.isArray(docdata?.b2b) ? docdata.b2b : [];
  const invoices = [];
  for (const supplier of suppliers) {
    const supplierGstin = String(supplier.ctin || supplier.gstin || '').trim().toUpperCase();
    for (const invoice of (Array.isArray(supplier.inv) ? supplier.inv : [])) {
      const details = Array.isArray(invoice.itms) ? invoice.itms : [];
      const sums = details.reduce((acc, item) => {
        const detail = item.itm_det || item;
        acc.taxableValue += amount(detail.txval ?? detail.taxableValue ?? 0);
        acc.cgst += amount(detail.camt ?? detail.cgst ?? 0);
        acc.sgst += amount(detail.samt ?? detail.sgst ?? 0);
        acc.igst += amount(detail.iamt ?? detail.igst ?? 0);
        return acc;
      }, { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 });
      const taxableValue = amount(invoice.txval ?? sums.taxableValue);
      const cgst = amount(invoice.camt ?? sums.cgst);
      const sgst = amount(invoice.samt ?? sums.sgst);
      const igst = amount(invoice.iamt ?? sums.igst);
      const totalTax = amount(invoice.tax ?? (cgst + sgst + igst));
      const invoiceNumber = String(invoice.inum || invoice.invoiceNumber || '').trim();
      if (supplierGstin && invoiceNumber) invoices.push({
        supplierGstin,
        supplierName: supplier.trdnm || supplier.tradeName || null,
        invoiceNumber,
        invoiceDate: invoiceDate(invoice.idt || invoice.invoiceDate),
        taxableValue,
        cgst,
        sgst,
        igst,
        totalTax,
      });
    }
  }
  if (!invoices.length) throw new Error('No supported B2B invoice rows were found. Credit/debit notes and other GSTR-2B sections are not imported by this workflow.');
  return invoices;
}

module.exports = { normalizeGstr2b, invoiceDate };
