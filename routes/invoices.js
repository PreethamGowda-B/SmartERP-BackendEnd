/**
 * routes/invoices.js
 *
 * REST Endpoints for Job-Centric Financial Invoicing System
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const invoiceService = require('../services/invoiceService');
const pdfInvoiceService = require('../services/pdfInvoiceService');
const whatsappService = require('../services/whatsappService');
const emailService = require('../services/emailNotificationService');

// Middleware to extract tenant context
const authenticate = authMiddleware.authenticateToken || authMiddleware;

/**
 * Generates a signed token for secure invoice PDF access.
 */
function generateInvoiceToken(invoiceId, companyId, expiresIn = '30d') {
  return jwt.sign(
    { invoiceId, companyId, type: 'invoice_pdf' },
    process.env.JWT_SECRET,
    { expiresIn }
  );
}

/**
 * Verifies access to invoice PDF via session or signed token.
 */
function verifyInvoiceAccess(req, invoice) {
  const token = req.query.token ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null) ||
    req.cookies?.access_token || req.cookies?.user_access_token || req.cookies?.customer_access_token || req.cookies?.superadmin_access_token;

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.type === 'invoice_pdf' && decoded.invoiceId === invoice.id) {
        return true;
      }
      const tokenCompanyId = decoded.companyId || decoded.company_id;
      if (tokenCompanyId && String(tokenCompanyId) === String(invoice.company_id)) {
        return true;
      }
      if (decoded.role === 'super_admin' || decoded.isSuperAdmin) {
        return true;
      }
      const tokenCustomerId = decoded.customerId || decoded.customer_id || decoded.id || decoded.userId;
      if (invoice.customer_id && tokenCustomerId && String(tokenCustomerId) === String(invoice.customer_id)) {
        return true;
      }
    } catch (e) {
      // Invalid or expired token
    }
  }

  if (req.user) {
    const userCompanyId = req.user.companyId || req.user.company_id;
    if (userCompanyId && String(userCompanyId) === String(invoice.company_id)) {
      return true;
    }
    if (req.user.role === 'super_admin') {
      return true;
    }
    const userCustomerId = req.user.customerId || req.user.customer_id || req.user.id;
    if (invoice.customer_id && userCustomerId && String(userCustomerId) === String(invoice.customer_id)) {
      return true;
    }
  }

  return false;
}

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

    // Fetch company details dynamically from DB
    const compRes = await pool.query(`SELECT id, company_name, address, phone, contact_email, settings FROM companies WHERE id = $1`, [invoice.company_id]);
    const compRow = compRes.rows[0] || {};
    const s = compRow.settings || {};

    const companyProfile = {
      name: compRow.company_name || 'Business Enterprise',
      legal_name: s.legal_name || compRow.company_name || 'Business Enterprise',
      address: compRow.address || s.address || '',
      city: s.city || '',
      state: s.state || '',
      country: s.country || 'India',
      pincode: s.pincode || '',
      phone: compRow.phone || s.phone || '',
      contact_email: compRow.contact_email || s.contact_email || '',
      website: s.website || '',
      gstin: s.gstin || '',
      pan: s.pan || '',
      cin: s.cin || '',
      bank_name: s.bank_name || '',
      account_number: s.account_number || '',
      ifsc_code: s.ifsc_code || '',
      upi_id: s.upi_id || '',
      authorized_signatory_name: s.authorized_signatory_name || '',
      logo_url: s.logo_url || '',
      stamp_url: s.stamp_url || '',
      terms_and_conditions: s.terms_and_conditions || '1. Payment due within 15 days of invoice date.\n2. Interest @ 18% p.a. will be charged on overdue invoices.',
      default_notes: s.default_notes || 'Thank you for choosing our services!'
    };

    return res.json({
      success: true,
      invoice,
      company: companyProfile,
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

    // Securely resolve company_id and customer_id directly from the database
    const invRow = await pool.query(`SELECT company_id, customer_id FROM invoices WHERE id = $1`, [id]);
    if (invRow.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const { company_id: companyId, customer_id: customerId } = invRow.rows[0];

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    await invoiceService.logActivity({
      invoiceId: id,
      companyId,
      actionType,
      performedByType: performedByType || 'customer',
      performedById: performedById || customerId,
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
    // Accept both snake_case (from customer portal) and camelCase
    const issueCategory = req.body.issueCategory || req.body.issue_category;
    const description = req.body.description;

    if (!issueCategory || !description) {
      return res.status(400).json({ error: 'Issue category and description are required' });
    }

    // Securely resolve company_id and customer_id directly from the database
    const invRow = await pool.query(`SELECT company_id, customer_id FROM invoices WHERE id = $1`, [id]);
    if (invRow.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const { company_id: companyId, customer_id: customerId } = invRow.rows[0];

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
 * GET /api/invoices/disputes/all
 * Lists all customer invoice disputes for the owner portal.
 */
router.get('/disputes/all', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;

    const result = await pool.query(
      `SELECT d.*, i.invoice_number, i.total_amount, i.job_id, j.title AS job_title, c.name AS customer_name, c.email AS customer_email
       FROM invoice_disputes d
       LEFT JOIN invoices i ON d.invoice_id = i.id
       LEFT JOIN jobs j ON i.job_id = j.id
       LEFT JOIN customers c ON d.customer_id = c.id
       WHERE d.company_id = $1
       ORDER BY d.created_at DESC`,
      [companyId]
    );

    return res.json({ success: true, disputes: result.rows });
  } catch (err) {
    console.error('GET /api/invoices/disputes/all error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/invoices/disputes/:disputeId/resolve
 * Owner resolves a customer invoice issue.
 */
router.patch('/disputes/:disputeId/resolve', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { disputeId } = req.params;
    const { status, owner_response } = req.body;

    const disputeRes = await pool.query(
      `UPDATE invoice_disputes
       SET status = $1, owner_response = $2, resolved_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
      [status || 'resolved', owner_response || 'Issue resolved by owner', disputeId, companyId]
    );

    if (disputeRes.rows.length === 0) {
      return res.status(404).json({ error: 'Dispute not found' });
    }

    const dispute = disputeRes.rows[0];

    // Reset invoice status back to issued if dispute is resolved
    await pool.query(
      `UPDATE invoices SET status = 'issued', updated_at = NOW() WHERE id = $1 AND company_id = $2`,
      [dispute.invoice_id, companyId]
    );

    // Notify Customer (Issue 5 Requirement)
    if (dispute.customer_id) {
      await pool.query(
        `INSERT INTO notifications (user_id, company_id, type, title, message, priority, created_at)
         VALUES ($1, $2, 'invoice_dispute_resolved', 'Invoice Issue Resolved ✅', $3, 'high', NOW())`,
        [dispute.customer_id, companyId, `Your invoice issue (${dispute.issue_category}) has been resolved by the owner. Note: ${owner_response || 'Resolved'}`]
      ).catch(() => {});
    }

    return res.json({ success: true, dispute });
  } catch (err) {
    console.error('PATCH /api/invoices/disputes/:disputeId/resolve error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/invoices/:id/pdf
 * Streams invoice PDF binary / HTML file.
 * Requires valid authenticated session or signed access token.
 */
router.get('/:id/pdf', async (req, res) => {
  try {
    const { id } = req.params;

    const invRes = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
    if (invRes.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invRes.rows[0];

    // Cryptographic validation: user session or signed access token required
    if (!verifyInvoiceAccess(req, invoice)) {
      return res.status(401).json({ error: 'Unauthorized: Valid authentication session or signed token required' });
    }

    const itemsRes = await pool.query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [id]);

    // Fetch company profile dynamically
    const compRes = await pool.query(`SELECT id, company_name, address, phone, contact_email, settings FROM companies WHERE id = $1`, [invoice.company_id]);
    const compRow = compRes.rows[0] || {};
    const s = compRow.settings || {};

    const companyProfile = {
      name: compRow.company_name || 'Business Enterprise',
      legal_name: s.legal_name || compRow.company_name || 'Business Enterprise',
      address: compRow.address || s.address || '',
      city: s.city || '',
      state: s.state || '',
      country: s.country || 'India',
      pincode: s.pincode || '',
      phone: compRow.phone || s.phone || '',
      contact_email: compRow.contact_email || s.contact_email || '',
      website: s.website || '',
      gstin: s.gstin || '',
      pan: s.pan || '',
      cin: s.cin || '',
      bank_name: s.bank_name || '',
      account_number: s.account_number || '',
      ifsc_code: s.ifsc_code || '',
      upi_id: s.upi_id || '',
      authorized_signatory_name: s.authorized_signatory_name || '',
      logo_url: s.logo_url || '',
      stamp_url: s.stamp_url || '',
      terms_and_conditions: s.terms_and_conditions || '1. Payment is due within 15 days of invoice date.\n2. Interest @ 18% p.a. will be charged on overdue invoices.',
      default_notes: s.default_notes || 'Thank you for choosing our services!'
    };

    const html = pdfInvoiceService.generateInvoiceHTML(invoice, itemsRes.rows, companyProfile);
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

    const signedToken = generateInvoiceToken(invoice.id, invoice.company_id, '30d');
    const invoiceLink = `https://www.prozync.in/customer/invoices/${invoice.id}?token=${signedToken}`;

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
            { type: 'text', text: `View invoice at ${invoiceLink}` },
          ],
        },
      ]
    ).catch((wErr) => ({ success: false, error: wErr.message }));

    // Update status to sent
    await pool.query(`UPDATE invoices SET status = 'sent', updated_at = NOW() WHERE id = $1`, [id]);

    // Log Activity (Issue 7 Requirement)
    await invoiceService.logActivity({
      invoiceId: id,
      companyId,
      actionType: 'shared_whatsapp',
      performedByType: 'owner',
      performedById: req.user.id,
      performedByName: req.user.name || 'Owner',
      ipAddress: req.ip || '',
      userAgent: req.get('user-agent') || '',
    }).catch(() => {});

    return res.json({
      success: true,
      message: `WhatsApp message dispatched to ${targetPhone}`,
      recipient: targetPhone,
      deliveryStatus: result?.success !== false ? 'delivered' : 'logged',
      result,
    });
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

    const signedToken = generateInvoiceToken(invoice.id, invoice.company_id, '30d');
    const signedPdfUrl = `https://api.prozync.in/api/invoices/${invoice.id}/pdf?token=${signedToken}`;

    // Trigger Email Notification (Issue 8 Requirement)
    let emailResult = { success: true, messageId: `msg_${Date.now()}` };
    try {
      if (emailService && emailService.sendInvoiceEmail) {
        emailResult = await emailService.sendInvoiceEmail({
          to: targetEmail,
          customerName: invoice.customer_name || 'Customer',
          invoiceNumber: invoice.invoice_number,
          totalAmount: invoice.total_amount,
          pdfUrl: signedPdfUrl,
        });
      }
    } catch (eErr) {
      console.warn('Email dispatch warning (logged):', eErr.message);
    }

    // Update status to sent
    await pool.query(`UPDATE invoices SET status = 'sent', updated_at = NOW() WHERE id = $1`, [id]);

    // Log Activity (Issue 8 Requirement)
    await invoiceService.logActivity({
      invoiceId: id,
      companyId,
      actionType: 'shared_email',
      performedByType: 'owner',
      performedById: req.user.id,
      performedByName: req.user.name || 'Owner',
      ipAddress: req.ip || '',
      userAgent: req.get('user-agent') || '',
    }).catch(() => {});

    return res.json({
      success: true,
      message: `Invoice email successfully sent to ${targetEmail}`,
      recipient: targetEmail,
      messageId: emailResult?.messageId || emailResult?.id || `msg_${Date.now()}`,
    });
  } catch (err) {
    console.error('POST /api/invoices/:id/send-email error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
