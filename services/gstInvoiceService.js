const { pool } = require("../db");

class GSTInvoiceService {
  /**
   * Computes GST tax splits and formats e-invoice payload.
   * @param {Object} params
   * @param {string} params.companyId - Tenant Scope
   * @param {string} params.customerName - Client name
   * @param {string} [params.customerGstin] - Customer GSTIN / Tax ID
   * @param {Array} params.items - Line items [{ description, hsnCode, quantity, unitPrice }]
   * @param {boolean} [params.isInterState] - True for IGST (interstate), False for CGST+SGST (intrastate)
   */
  static async generateGSTInvoice({ companyId, customerName, customerGstin = "N/A", items = [], isInterState = false }) {
    if (!companyId || !customerName || !items || items.length === 0) {
      throw new Error("Company ID, customer name, and at least one line item are required.");
    }

    let subtotal = 0;
    const computedItems = items.map((item) => {
      const qty = parseFloat(item.quantity || 1);
      const price = parseFloat(item.unitPrice || 0);
      const total = qty * price;
      subtotal += total;

      return {
        description: item.description || "Service / Item",
        hsnCode: item.hsnCode || "998311", // Default IT/Consulting HSN
        quantity: qty,
        unitPrice: price,
        total: total,
      };
    });

    const taxRate = 0.18; // Standard 18% GST rate
    const totalTax = subtotal * taxRate;

    let cgst = 0;
    let sgst = 0;
    let igst = 0;

    if (isInterState) {
      igst = totalTax;
    } else {
      cgst = totalTax / 2;
      sgst = totalTax / 2;
    }

    const grandTotal = subtotal + totalTax;
    const invoiceNumber = `GST-INV-${Date.now().toString().slice(-6)}`;

    // Store invoice in database
    const res = await pool.query(
      `INSERT INTO invoices (customer_name, amount, due_date, status, company_id, created_at)
       VALUES ($1, $2, NOW() + INTERVAL '15 days', 'pending', $3, NOW())
       RETURNING id, customer_name, amount, due_date, status, created_at`,
      [customerName, grandTotal, companyId]
    );

    return {
      success: true,
      invoice: {
        id: res.rows[0].id,
        invoiceNumber,
        customerName,
        customerGstin,
        createdDate: new Date().toISOString().split("T")[0],
        dueDate: res.rows[0].due_date,
        isInterState,
        subtotal: subtotal.toFixed(2),
        cgst: cgst.toFixed(2),
        sgst: sgst.toFixed(2),
        igst: igst.toFixed(2),
        totalTax: totalTax.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        currency: "INR (₹)",
        lineItems: computedItems,
      },
    };
  }
}

module.exports = GSTInvoiceService;
