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

    const gstRes = await pool.query(
      `SELECT 
         id, invoice_number, customer_name, subtotal, cgst, sgst, igst, total_tax, total_amount, is_inter_state, created_at, status
       FROM invoices
       WHERE company_id = $1 AND is_latest = TRUE AND status != 'cancelled'
       ORDER BY created_at DESC`,
      [companyId]
    );

    let totalSubtotal = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;
    let totalTax = 0;

    gstRes.rows.forEach((row) => {
      totalSubtotal += parseFloat(row.subtotal || 0);
      totalCgst += parseFloat(row.cgst || 0);
      totalSgst += parseFloat(row.sgst || 0);
      totalIgst += parseFloat(row.igst || 0);
      totalTax += parseFloat(row.total_tax || 0);
    });

    return res.json({
      success: true,
      totals: {
        subtotal: totalSubtotal.toFixed(2),
        cgst: totalCgst.toFixed(2),
        sgst: totalSgst.toFixed(2),
        igst: totalIgst.toFixed(2),
        total_tax: totalTax.toFixed(2),
      },
      invoices: gstRes.rows,
    });
  } catch (err) {
    console.error('GET /api/finance/gst-summary error:', err.message);
    return res.status(500).json({ error: err.message });
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
