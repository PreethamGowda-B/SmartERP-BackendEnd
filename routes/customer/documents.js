/**
 * routes/customer/documents.js
 *
 * Dedicated router for Customer Portal document center.
 * Protected by authenticateCustomer middleware.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../../db');

// ─── GET /api/customer/documents (List customer documents) ─────────────────
router.get('/', async (req, res) => {
  try {
    const customerId = req.customer?.id || req.customer?.userId;
    const companyId = req.customer?.companyId || req.customer?.company_id;

    if (!customerId || !companyId) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Missing customer or company context' });
    }

    // Fetch invoices, job attachments, and reports strictly for this customer and company
    const query = `
      SELECT id::text, COALESCE(invoice_number, 'Invoice #' || id::text) as name, 'Invoice' as category, pdf_url as file_url, created_at
      FROM invoices
      WHERE customer_id::text = $1::text AND company_id::text = $2::text
      UNION ALL
      SELECT id::text, COALESCE(title, 'Job Report #' || id::text) as name, 'Service Report' as category, '' as file_url, created_at
      FROM jobs
      WHERE customer_id::text = $1::text AND company_id::text = $2::text AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 100
    `;

    const result = await pool.query(query, [customerId, companyId]).catch(async (err) => {
      console.warn("⚠️ Query customer documents UNION failed, falling back to simple query:", err.message);
      return pool.query(
        `SELECT id::text, COALESCE(invoice_number, 'Invoice #' || id::text) as name, 'Invoice' as category, pdf_url as file_url, created_at FROM invoices WHERE customer_id::text = $1::text AND company_id::text = $2::text ORDER BY created_at DESC`,
        [customerId, companyId]
      ).catch(() => ({ rows: [] }));
    });

    res.json({ success: true, documents: result.rows || [] });
  } catch (err) {
    console.error('❌ Error fetching customer documents:', err.message);
    res.json({ success: true, documents: [] });
  }
});

module.exports = router;
