/**
 * routes/finance.js
 *
 * REST Endpoints for Finance Subsystem:
 * Dashboard KPIs, Payments Log, AR Aging, GST Reports, and Financial Statements.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const invoiceService = require('../services/invoiceService');

const authenticate = authMiddleware.authenticateToken || authMiddleware;

/**
 * GET /api/finance/summary
 * Finance Dashboard KPIs: Revenue, Outstanding AR, Tax Liabilities, Invoice Counts.
 */
router.get('/summary', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;

    // Total Invoiced & Received
    const invStats = await pool.query(
      `SELECT 
         COALESCE(SUM(total_amount), 0) AS total_invoiced,
         COALESCE(SUM(amount_paid), 0)  AS total_paid,
         COALESCE(SUM(amount_due), 0)   AS total_outstanding,
         COALESCE(SUM(cgst + sgst + igst), 0) AS total_tax_collected,
         COUNT(*) FILTER (WHERE status = 'issued') AS pending_count,
         COUNT(*) FILTER (WHERE status = 'paid') AS paid_count,
         COUNT(*) FILTER (WHERE status = 'disputed') AS disputed_count,
         COUNT(*) FILTER (WHERE status = 'sent') AS sent_count
       FROM invoices
       WHERE company_id = $1 AND is_latest = TRUE`,
      [companyId]
    );

    // Overdue count & amount from AR schedules
    const arStats = await pool.query(
      `SELECT 
         COUNT(*) AS overdue_count,
         COALESCE(SUM(amount_outstanding), 0) AS overdue_amount
       FROM ar_collection_schedules
       WHERE company_id = $1 AND is_paused = FALSE AND due_date < NOW()`,
      [companyId]
    );

    return res.json({
      success: true,
      summary: {
        total_invoiced: parseFloat(invStats.rows[0].total_invoiced),
        total_paid: parseFloat(invStats.rows[0].total_paid),
        total_outstanding: parseFloat(invStats.rows[0].total_outstanding),
        total_tax_collected: parseFloat(invStats.rows[0].total_tax_collected),
        pending_count: parseInt(invStats.rows[0].pending_count, 10),
        paid_count: parseInt(invStats.rows[0].paid_count, 10),
        disputed_count: parseInt(invStats.rows[0].disputed_count, 10),
        sent_count: parseInt(invStats.rows[0].sent_count, 10),
        overdue_count: parseInt(arStats.rows[0].overdue_count, 10),
        overdue_amount: parseFloat(arStats.rows[0].overdue_amount),
      },
    });
  } catch (err) {
    console.error('GET /api/finance/summary error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/finance/ar-aging
 * Accounts Receivable Aging Matrix (Current, 1-30 days, 31-60 days, 60+ days).
 */
router.get('/ar-aging', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;

    const agingRes = await pool.query(
      `SELECT 
         id, invoice_id, customer_name, customer_email, customer_phone, invoice_amount, amount_outstanding, due_date, current_stage, is_paused,
         CASE 
           WHEN due_date >= NOW() THEN 'current'
           WHEN due_date < NOW() AND due_date >= NOW() - INTERVAL '30 days' THEN '1_30'
           WHEN due_date < NOW() - INTERVAL '30 days' AND due_date >= NOW() - INTERVAL '60 days' THEN '31_60'
           ELSE '60_plus'
         END AS aging_bucket
       FROM ar_collection_schedules
       WHERE company_id = $1 AND amount_outstanding > 0
       ORDER BY due_date ASC`,
      [companyId]
    );

    const buckets = { current: 0, '1_30': 0, '31_60': 0, '60_plus': 0 };
    agingRes.rows.forEach((row) => {
      buckets[row.aging_bucket] += parseFloat(row.amount_outstanding);
    });

    return res.json({
      success: true,
      buckets,
      schedules: agingRes.rows,
    });
  } catch (err) {
    console.error('GET /api/finance/ar-aging error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/finance/gst-summary
 * GSTR-1 Sales Tax Report Summary (CGST, SGST, IGST breakdown).
 */
router.get('/gst-summary', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const role = String(req.user.role || '').toLowerCase();
    if (!['owner', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'Only company owners and administrators can view GST summaries.' });
    }
    if (!companyId) return res.status(401).json({ error: 'Company context is required.' });

    const period = req.query.period == null ? null : String(req.query.period);
    let periodStart = null;
    let periodEnd = null;
    if (period) {
      const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
      if (!match) return res.status(400).json({ error: 'Period must be in YYYY-MM format.' });
      const year = Number(match[1]);
      const month = Number(match[2]);
      periodStart = `${match[1]}-${match[2]}-01`;
      periodEnd = month === 12 ? `${year + 1}-01-01` : `${match[1]}-${String(month + 1).padStart(2, '0')}-01`;
    }

    const params = period ? [String(companyId), periodStart, periodEnd] : [String(companyId)];
    const periodClause = period ? "AND (created_at AT TIME ZONE 'Asia/Kolkata') >= $2::date::timestamp AND (created_at AT TIME ZONE 'Asia/Kolkata') < $3::date::timestamp" : '';
    const [gstRes, totalsRes] = await Promise.all([
      pool.query(
        `SELECT id, invoice_number, customer_name, subtotal, cgst, sgst, igst, total_tax,
                total_amount, is_inter_state, created_at, status
           FROM invoices
          WHERE company_id::text = $1::text AND is_latest = TRUE
            AND LOWER(COALESCE(status, '')) IN ('issued', 'sent', 'viewed', 'paid', 'partially_paid', 'disputed')
            ${periodClause}
          ORDER BY created_at DESC, id DESC`,
        params
      ),
      pool.query(
        `SELECT COALESCE(SUM(subtotal), 0)::numeric(18,2)::text AS subtotal,
                COALESCE(SUM(cgst), 0)::numeric(18,2)::text AS cgst,
                COALESCE(SUM(sgst), 0)::numeric(18,2)::text AS sgst,
                COALESCE(SUM(igst), 0)::numeric(18,2)::text AS igst,
                COALESCE(SUM(total_tax), 0)::numeric(18,2)::text AS total_tax
           FROM invoices
          WHERE company_id::text = $1::text AND is_latest = TRUE
            AND LOWER(COALESCE(status, '')) IN ('issued', 'sent', 'viewed', 'paid', 'partially_paid', 'disputed')
            ${periodClause}`,
        params
      ),
    ]);

    return res.json({
      success: true,
      period,
      totals: totalsRes.rows[0],
      invoices: gstRes.rows,
    });
  } catch (err) {
    console.error('GET /api/finance/gst-summary error:', err.message);
    return res.status(500).json({ error: 'Could not load the GST summary. Please retry.' });
  }
});

/**
 * GET /api/finance/payments
 * Payments Log List (Razorpay, Cash, Bank Transfer, Cheque, UPI).
 */
router.get('/payments', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;

    const payRes = await pool.query(
      `SELECT p.*, i.invoice_number, i.customer_name
       FROM invoice_payments p
       LEFT JOIN invoices i ON p.invoice_id = i.id
       WHERE p.company_id = $1
       ORDER BY p.payment_date DESC`,
      [companyId]
    );

    return res.json({ success: true, payments: payRes.rows });
  } catch (err) {
    console.error('GET /api/finance/payments error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/finance/payments/record
 * Manually records a payment for an invoice (Cash / Bank Transfer / UPI / Cheque).
 */
router.post('/payments/record', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const userId = req.user.id || req.user.userId;
    const { invoiceId, paymentMethod, transactionReference, amount, notes } = req.body;

    if (!invoiceId || !paymentMethod || !amount) {
      return res.status(400).json({ error: 'Invoice ID, payment method, and amount are required' });
    }

    const result = await invoiceService.recordPayment({
      invoiceId,
      companyId,
      paymentMethod,
      transactionReference,
      amount,
      notes,
      recordedBy: userId,
    });

    return res.json(result);
  } catch (err) {
    console.error('POST /api/finance/payments/record error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
