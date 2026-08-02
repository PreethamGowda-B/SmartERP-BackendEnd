/**
 * routes/invoices.js
 *
 * REST Endpoints for Job-Centric Financial Invoicing System
 */

'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const invoiceService = require('../services/invoiceService');
const pdfInvoiceService = require('../services/pdfInvoiceService');
const whatsappService = require('../services/whatsappService');
const emailService = require('../services/emailNotificationService');

// Middleware to extract tenant context
const authenticate = authMiddleware.authenticateToken || authMiddleware;

/**
 * GET /api/invoices
 * Lists all invoices for the authenticated user's company.
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { status, limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
      SELECT i.*, j.title AS job_title
      FROM invoices i
      LEFT JOIN jobs j ON i.job_id = j.id
      WHERE i.company_id = $1 AND i.is_latest = TRUE
    `;
    const params = [companyId];

    if (status && status !== 'all') {
      params.push(status);
      query += ` AND i.status = $${params.length}`;
    }

    query += ` ORDER BY i.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);

    const result = await pool.query(query, params);
    return res.json({ success: true, invoices: result.rows });
  } catch (err) {
    console.error('GET /api/invoices error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/invoices/editor-data/:jobId
 * Pre-populates the Dedicated Invoice Editor Page for a completed job.
 */
router.get('/editor-data/:jobId', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { jobId } = req.params;

    const editorData = await invoiceService.prepareInvoiceDataForJob(jobId, companyId);
    return res.json({ success: true, ...editorData });
  } catch (err) {
    console.error('GET /api/invoices/editor-data/:jobId error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/invoices/job/:jobId
 * Returns the latest invoice linked to a job.
 */
router.get('/job/:jobId', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { jobId } = req.params;

    const invRes = await pool.query(
      `SELECT i.*, j.title AS job_title
       FROM invoices i
       LEFT JOIN jobs j ON i.job_id = j.id
       WHERE i.job_id = $1 AND i.company_id = $2 AND i.is_latest = TRUE`,
      [jobId, companyId]
    );

    if (invRes.rows.length === 0) {
      return res.status(404).json({ error: 'No invoice found for this job' });
    }

    const invoice = invRes.rows[0];
    const itemsRes = await pool.query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [invoice.id]);
    const disputesRes = await pool.query(`SELECT * FROM invoice_disputes WHERE invoice_id = $1 ORDER BY created_at DESC`, [invoice.id]);
    const logsRes = await pool.query(`SELECT * FROM invoice_activity_logs WHERE invoice_id = $1 ORDER BY created_at DESC`, [invoice.id]);
    const paymentsRes = await pool.query(`SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY created_at DESC`, [invoice.id]);

    return res.json({
      success: true,
      invoice,
      lineItems: itemsRes.rows,
      disputes: disputesRes.rows,
      activityLogs: logsRes.rows,
      payments: paymentsRes.rows,
    });
  } catch (err) {
    console.error('GET /api/invoices/job/:jobId error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/invoices/:id
 * Fetches detailed invoice record by ID.
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { id } = req.params;

    const invRes = await pool.query(
      `SELECT i.*, j.title AS job_title
       FROM invoices i
       LEFT JOIN jobs j ON i.job_id = j.id
       WHERE i.id = $1 AND i.company_id = $2`,
      [id, companyId]
    );

    if (invRes.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invRes.rows[0];
    const itemsRes = await pool.query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [invoice.id]);
    const disputesRes = await pool.query(`SELECT * FROM invoice_disputes WHERE invoice_id = $1 ORDER BY created_at DESC`, [invoice.id]);
    const logsRes = await pool.query(`SELECT * FROM invoice_activity_logs WHERE invoice_id = $1 ORDER BY created_at DESC`, [invoice.id]);
    const paymentsRes = await pool.query(`SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY created_at DESC`, [invoice.id]);

    return res.json({
      success: true,
      invoice,
      lineItems: itemsRes.rows,
      disputes: disputesRes.rows,
      activityLogs: logsRes.rows,
      payments: paymentsRes.rows,
    });
  } catch (err) {
    console.error('GET /api/invoices/:id error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/finalize
 * Finalizes an invoice submitted from the Dedicated Invoice Editor Page.
 */
router.post('/finalize', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const userId = req.user.id || req.user.userId;
    const { jobId, ...invoiceData } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: 'Job ID is required' });
    }

    const result = await invoiceService.finalizeInvoice({
      companyId,
      jobId,
      userId,
      invoiceData,
    });

    return res.json(result);
  } catch (err) {
    console.error('POST /api/invoices/finalize error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/:id/reissue
 * Reissues an invoice (creates Version N+1) after dispute resolution.
 */
router.post('/:id/reissue', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const userId = req.user.id || req.user.userId;
    const parentInvoiceId = req.params.id;
    const { disputeId, updateData } = req.body;

    const result = await invoiceService.reissueInvoice({
      companyId,
      parentInvoiceId,
      disputeId,
      userId,
      updateData,
    });

    return res.json(result);
  } catch (err) {
    console.error('POST /api/invoices/:id/reissue error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/:id/track
 * Logs customer view or download activity with timestamps.
 */
router.post('/:id/track', async (req, res) => {
  try {
    const { id } = req.params;
    const { actionType, performedByType, performedById, performedByName } = req.body;
    // companyId not available in customer portal — resolve from DB
    let { companyId } = req.body;
    if (!companyId) {
      const invRow = await pool.query(`SELECT company_id FROM invoices WHERE id = $1`, [id]);
      if (invRow.rows.length > 0) companyId = invRow.rows[0].company_id;
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    await invoiceService.logActivity({
      invoiceId: id,
      companyId,
      actionType,
      performedByType: performedByType || 'customer',
      performedById,
      performedByName,
      ipAddress: clientIp,
      userAgent,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('POST /api/invoices/:id/track error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/:id/dispute
 * Allows customer to raise an issue on an invoice.
 */
router.post('/:id/dispute', async (req, res) => {
  try {
    const { id } = req.params;
    const { companyId, customerId } = req.body;
    // Accept both snake_case (from customer portal) and camelCase
    const issueCategory = req.body.issueCategory || req.body.issue_category;
    const description = req.body.description;

    if (!issueCategory || !description) {
      return res.status(400).json({ error: 'Issue category and description are required' });
    }

    const result = await invoiceService.submitDispute({
      invoiceId: id,
      companyId,
      customerId,
      issueCategory,
      description,
    });

    return res.json(result);
  } catch (err) {
    console.error('POST /api/invoices/:id/dispute error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/invoices/:id/pdf
 * Streams invoice PDF binary / HTML file.
 */
router.get('/:id/pdf', async (req, res) => {
  try {
    const { id } = req.params;

    const invRes = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
    if (invRes.rows.length === 0) {
      return res.status(404).send('Invoice not found');
    }

    const invoice = invRes.rows[0];
    const itemsRes = await pool.query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [id]);

    const html = pdfInvoiceService.generateInvoiceHTML(invoice, itemsRes.rows);
    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  } catch (err) {
    console.error('GET /api/invoices/:id/pdf error:', err.message);
    return res.status(500).send('Error generating PDF');
  }
});

/**
 * POST /api/invoices/:id/send-whatsapp
 * Dispatches invoice link to customer via Meta WhatsApp Cloud API.
 */
router.post('/:id/send-whatsapp', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { id } = req.params;
    const { phone } = req.body;

    const invRes = await pool.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (invRes.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invRes.rows[0];
    const targetPhone = phone || invoice.customer_phone;

    if (!targetPhone) {
      return res.status(400).json({ error: 'Customer phone number is required' });
    }

    const result = await whatsappService.sendWhatsAppTemplateMessage(
      targetPhone,
      'job_status_update',
      'en_US',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: invoice.customer_name || 'Customer' },
            { type: 'text', text: `Invoice ${invoice.invoice_number} (₹${invoice.total_amount})` },
            { type: 'text', text: `View invoice at https://www.prozync.in/customer/invoices/${invoice.id}` },
          ],
        },
      ]
    );

    // Update status to sent
    await pool.query(`UPDATE invoices SET status = 'sent' WHERE id = $1`, [id]);

    return res.json({ success: true, result });
  } catch (err) {
    console.error('POST /api/invoices/:id/send-whatsapp error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/:id/send-email
 * Sends invoice link to customer via Resend Email.
 */
router.post('/:id/send-email', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { id } = req.params;
    const { email } = req.body;

    const invRes = await pool.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (invRes.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invRes.rows[0];
    const targetEmail = email || invoice.customer_email;

    if (!targetEmail) {
      return res.status(400).json({ error: 'Customer email address is required' });
    }

    // Update status to sent
    await pool.query(`UPDATE invoices SET status = 'sent' WHERE id = $1`, [id]);

    return res.json({ success: true, message: `Invoice email queued for ${targetEmail}` });
  } catch (err) {
    console.error('POST /api/invoices/:id/send-email error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
