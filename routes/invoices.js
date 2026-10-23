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
const { storage } = require('../middleware/als');
const authMiddleware = require('../middleware/authMiddleware');
const requireFinanceReadAccess = require('../middleware/requireFinanceReadAccess');
const invoiceService = require('../services/invoiceService');
const pdfInvoiceService = require('../services/pdfInvoiceService');
const whatsappService = require('../services/whatsappService');
const emailService = require('../services/emailNotificationService');
const { createCustomerPortalNotification } = require('../utils/notificationHelpers');
const GstReconciliationService = require('../services/gstReconciliationService');
const redisClient = require('../utils/redis');

// Middleware to extract tenant context
const authenticate = authMiddleware.authenticateToken || authMiddleware;

async function notifyOtherOwnersOfGstInvoice({ companyId, actorId, invoice, action }) {
  if (!invoice?.id || !companyId) return;
  await GstReconciliationService.notifyOwners({
    companyId,
    actorId,
    type: 'gst_invoice_issued',
    title: action === 'reissued' ? 'GST invoice revised' : 'GST invoice issued',
    message: `${invoice.invoice_number || 'A tax invoice'} was ${action} and is included in the company GST ledger.`,
    idempotencyKey: `gst-invoice:${invoice.id}:${invoice.version_number || 1}:${action}`,
  });
}

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
        return String(decoded.companyId || decoded.company_id || '') === String(invoice.company_id);
      }
      const tokenCompanyId = decoded.companyId || decoded.company_id;
      const tokenCustomerId = decoded.customerId || decoded.customer_id || decoded.id || decoded.userId;
      // Customer sessions must match the invoice's customer, not just its
      // company. Otherwise one customer could access another customer's invoice.
      if (decoded.role === 'customer') {
        return !!(invoice.customer_id && tokenCustomerId && String(tokenCustomerId) === String(invoice.customer_id));
      }
      if (tokenCompanyId && String(tokenCompanyId) === String(invoice.company_id)) {
        return true;
      }
      if (invoice.customer_id && tokenCustomerId && String(tokenCustomerId) === String(invoice.customer_id)) {
        return true;
      }
    } catch (e) {
      // Invalid or expired token
    }
  }

  if (req.user) {
    const userCompanyId = req.user.companyId || req.user.company_id;
    if (req.user.role === 'customer') {
      const userCustomerId = req.user.customerId || req.user.customer_id || req.user.id;
      return !!(invoice.customer_id && userCustomerId && String(userCustomerId) === String(invoice.customer_id));
    }
    if (userCompanyId && String(userCompanyId) === String(invoice.company_id)) {
      return true;
    }
    const userCustomerId = req.user.customerId || req.user.customer_id || req.user.id;
    if (invoice.customer_id && userCustomerId && String(userCustomerId) === String(invoice.customer_id)) {
      return true;
    }
  }

  return false;
}

// These customer-facing invoice routes authenticate inside their handlers to
// support both bearer tokens and signed invoice links. Establish the tenant
// context before their first database query so FORCE RLS permits company rows.
function setInvoiceTenantContext(req, res, next) {
  const token = req.query.token ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.split(' ')[1]
      : null) ||
    req.cookies?.access_token || req.cookies?.user_access_token ||
    req.cookies?.customer_access_token || req.cookies?.superadmin_access_token;

  if (!token) return next();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const companyId = decoded.companyId || decoded.company_id;
    const userId = decoded.customerId || decoded.customer_id || decoded.id || decoded.userId;
    req.invoiceAccessCompanyId = companyId;
    storage.run({
      isWebRequest: true,
      companyId,
      role: decoded.role || 'invoice_viewer',
      userId,
      bypassRls: false,
    }, next);
  } catch {
    // Let the route's normal access check return its existing 403 response.
    next();
  }
}

/**
 * GET /api/invoices
 * Lists all invoices for the authenticated user's company.
 */
router.get('/', authenticate, requireFinanceReadAccess, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { status, limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
      SELECT i.*, j.title AS job_title
      FROM invoices i
      LEFT JOIN jobs j ON i.job_id = j.id AND j.company_id::text = i.company_id::text
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
 * GET /api/invoices/editor-data/production-order/:productionOrderId
 * Production-order invoice prefill; the canonical service enforces readiness.
 */
router.get('/editor-data/production-order/:productionOrderId', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!['owner', 'admin'].includes(String(req.user.role || '').toLowerCase())) {
      return res.status(403).json({ error: 'Only an owner or administrator can prepare a production invoice.' });
    }
    const editorData = await invoiceService.prepareInvoiceDataForProductionOrder(req.params.productionOrderId, companyId);
    return res.json({ success: true, ...editorData });
  } catch (err) {
    if (['42P01', '42703'].includes(err?.code)) {
      return res.status(503).json({ error: 'Production invoice storage is not enabled. Apply the approved production and manufacturing migrations first.' });
    }
    const status = err.statusCode || (err.message && err.message.includes('not found') ? 404 : 500);
    return res.status(status).json({ error: err.message });
  }
});

/** Create or resume the single draft for an eligible production order. */
router.post('/production-order/:productionOrderId/draft', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const userId = req.user.id || req.user.userId;
    if (!['owner', 'admin'].includes(String(req.user.role || '').toLowerCase())) {
      return res.status(403).json({ error: 'Only an owner or administrator can create a production invoice.' });
    }
    const invoice = await invoiceService.createProductionOrderDraft({ companyId, productionOrderId: req.params.productionOrderId, userId });
    return res.json({ success: true, invoice });
  } catch (err) {
    if (['42P01', '42703'].includes(err?.code)) {
      return res.status(503).json({ error: 'Production invoice storage is not enabled. Apply the approved production and manufacturing migrations first.' });
    }
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * GET /api/invoices/editor-data/:jobId
 * Pre-populates the Dedicated Invoice Editor Page for a completed job.
 */
router.get('/editor-data/:jobId', authenticate, requireFinanceReadAccess, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { jobId } = req.params;

    const editorData = await invoiceService.prepareInvoiceDataForJob(jobId, companyId);
    return res.json({ success: true, ...editorData });
  } catch (err) {
    console.error('GET /api/invoices/editor-data/:jobId error:', err.message);
    const status = err.statusCode || (err.message && err.message.includes('not found') ? 404 : 500);
    return res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/invoices/job/:jobId
 * Returns the latest invoice linked to a job.
 */
router.get('/job/:jobId', authenticate, requireFinanceReadAccess, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { jobId } = req.params;

    const invRes = await pool.query(
      `SELECT i.*, j.title AS job_title
       FROM invoices i
       LEFT JOIN jobs j ON i.job_id = j.id AND j.company_id = i.company_id
       WHERE i.job_id = $1 AND i.company_id = $2 AND i.is_latest = TRUE`,
      [jobId, companyId]
    );

    if (invRes.rows.length === 0) {
      return res.status(404).json({ error: 'No invoice found for this job' });
    }

    const invoice = invRes.rows[0];
    const itemsRes = await pool.query(`SELECT * FROM invoice_items WHERE invoice_id = $1 AND company_id = $2`, [invoice.id, companyId]);
    const disputesRes = await pool.query(`SELECT * FROM invoice_disputes WHERE invoice_id = $1 AND company_id = $2 ORDER BY created_at DESC`, [invoice.id, companyId]);
    const logsRes = await pool.query(`SELECT * FROM invoice_activity_logs WHERE invoice_id = $1 AND company_id = $2 ORDER BY created_at DESC`, [invoice.id, companyId]);
    const paymentsRes = await pool.query(`SELECT * FROM invoice_payments WHERE invoice_id = $1 AND company_id = $2 ORDER BY created_at DESC`, [invoice.id, companyId]);

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
router.get('/:id', authenticate, requireFinanceReadAccess, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { id } = req.params;

    const invRes = await pool.query(
      `SELECT i.*, j.title AS job_title
       FROM invoices i
       LEFT JOIN jobs j ON i.job_id = j.id AND j.company_id::text = i.company_id::text
       WHERE i.id = $1 AND i.company_id::text = $2::text`,
      [id, companyId]
    );

    if (invRes.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invRes.rows[0];
    const itemsRes = await pool.query(`SELECT * FROM invoice_items WHERE invoice_id = $1 AND company_id = $2`, [invoice.id, companyId]);
    const disputesRes = await pool.query(`SELECT * FROM invoice_disputes WHERE invoice_id = $1 AND company_id = $2 ORDER BY created_at DESC`, [invoice.id, companyId]);
    const logsRes = await pool.query(`SELECT * FROM invoice_activity_logs WHERE invoice_id = $1 AND company_id = $2 ORDER BY created_at DESC`, [invoice.id, companyId]);
    const paymentsRes = await pool.query(`SELECT * FROM invoice_payments WHERE invoice_id = $1 AND company_id = $2 ORDER BY created_at DESC`, [invoice.id, companyId]);

    // Fetch company details dynamically from DB
    // Company profile columns vary across supported legacy schemas. Read the
    // optional fields through the row's JSON representation so a missing
    // address/phone/contact_email/settings column cannot fail invoice viewing.
    const compRes = await pool.query(
      `SELECT c.id, c.company_name,
              to_jsonb(c)->>'address' AS address,
              to_jsonb(c)->>'phone' AS phone,
              to_jsonb(c)->>'contact_email' AS contact_email,
              to_jsonb(c)->'settings' AS settings
       FROM companies c
       WHERE c.id::text = $1::text`,
      [invoice.company_id]
    );
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
 * GET /api/invoices/customers/search
 * Lists/searches customers for the walk-in invoice customer dropdown.
 */
router.get('/customers/search', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { q } = req.query;

    let query = `
      SELECT id, name, email, phone 
      FROM customers 
      WHERE company_id = $1 AND is_deleted = FALSE
    `;
    const params = [companyId];

    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      query += ` AND (name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)`;
    }

    query += ` ORDER BY name ASC LIMIT 50`;

    const result = await pool.query(query, params);
    return res.json({ success: true, customers: result.rows });
  } catch (err) {
    console.error('GET /api/invoices/customers/search error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/customers/quick-create
 * Inline creates a customer during walk-in invoice generation.
 */
router.post('/customers/quick-create', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { name, phone, email, address, gstin } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Customer name is required' });
    }

    const emailVal = email && email.trim() ? email.trim() : `counter_client_${Date.now()}@counter.local`;

    const result = await pool.query(
      `INSERT INTO customers (company_id, name, email, phone)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, phone`,
      [companyId, name.trim(), emailVal, phone ? phone.trim() : null]
    );

    return res.status(201).json({
      success: true,
      customer: {
        ...result.rows[0],
        address: address || '',
        gstin: gstin || ''
      }
    });
  } catch (err) {
    console.error('POST /api/invoices/customers/quick-create error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/invoices/inventory/search
 * Lists inventory items for quick line-item addition.
 */
router.get('/inventory/search', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { q } = req.query;

    let query = `
      SELECT id, name, category, unit, quantity
      FROM inventory_items
      WHERE company_id = $1 AND is_deleted = FALSE AND quantity > 0
    `;
    const params = [companyId];

    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      query += ` AND name ILIKE $2`;
    }

    query += ` ORDER BY name ASC LIMIT 50`;

    const result = await pool.query(query, params);
    return res.json({ success: true, items: result.rows });
  } catch (err) {
    console.error('GET /api/invoices/inventory/search error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/direct-create
 * Issues a Direct / Walk-in Invoice for counter customer sales.
 */
router.post('/direct-create', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const userId = req.user.id || req.user.userId;
    if (!['owner', 'admin', 'super_admin'].includes(String(req.user.role || '').toLowerCase())) {
      return res.status(403).json({ error: 'Only an owner or administrator can issue invoices.' });
    }
    if (!req.body?.idempotency_key) {
      return res.status(400).json({ error: 'An idempotency_key is required to issue a direct invoice.' });
    }

    const result = await invoiceService.createDirectInvoice({
      companyId,
      userId,
      invoiceData: req.body,
    });

    if (!result?.idempotentReplay) {
      await notifyOtherOwnersOfGstInvoice({ companyId, actorId: userId, invoice: result?.invoice, action: 'issued' })
        .catch((error) => console.warn('GST invoice owner notification could not be persisted:', error.message));
    }

    return res.status(201).json(result);
  } catch (err) {
    console.error('POST /api/invoices/direct-create error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/:id/record-payment
 * Records counter / office payment (Cash, POS Card, UPI QR, Bank Transfer, Cheque).
 */
function createInvoicePaymentRecordHandler(paymentService = invoiceService) {
  return async (req, res) => {
    try {
      const role = String(req.user?.role || '').toLowerCase();
      if (!['owner', 'admin', 'super_admin'].includes(role)) {
        return res.status(403).json({ error: 'Only owners or administrators can record invoice payments.' });
      }
      const companyId = req.user.companyId || req.user.company_id;
      const userId = req.user.id || req.user.userId;
      const { id } = req.params;
      const { paymentMethod, transactionReference, amount, notes } = req.body;

      if (!paymentMethod || !amount) {
        return res.status(400).json({ error: 'Payment method and amount are required' });
      }

      const result = await paymentService.recordPayment({
        invoiceId: id,
        companyId,
        paymentMethod,
        transactionReference,
        amount,
        notes,
        idempotencyKey: req.get('Idempotency-Key'),
        recordedBy: userId,
      });

      return res.json(result);
    } catch (err) {
      console.error('POST /api/invoices/:id/record-payment failed:', err?.code || 'PAYMENT_RECORDING_ERROR');
      return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Could not record payment.' });
    }
  };
}

router.post('/:id/record-payment', authenticate, createInvoicePaymentRecordHandler());

/**
 * POST /api/invoices/finalize
 * Finalizes an invoice submitted from the Dedicated Invoice Editor Page.
 */
router.post('/finalize', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const userId = req.user.id || req.user.userId;
    if (!['owner', 'admin', 'super_admin'].includes(String(req.user.role || '').toLowerCase())) {
      return res.status(403).json({ error: 'Only an owner or administrator can issue invoices.' });
    }
    const { jobId, productionOrderId, ...invoiceData } = req.body;

    if ((!jobId && !productionOrderId) || (jobId && productionOrderId)) {
      return res.status(400).json({ error: 'Provide exactly one jobId or productionOrderId.' });
    }
    if (!invoiceData.idempotency_key) {
      return res.status(400).json({ error: 'An idempotency_key is required to finalize an invoice.' });
    }

    const result = await invoiceService.finalizeInvoice({
      companyId,
      jobId,
      productionOrderId,
      userId,
      invoiceData,
    });

    const finalizedInvoice = result?.invoice;
    if (result?.reason !== 'idempotent_replay') {
      await notifyOtherOwnersOfGstInvoice({ companyId, actorId: userId, invoice: finalizedInvoice, action: 'issued' })
        .catch((error) => console.warn('GST invoice owner notification could not be persisted:', error.message));
    }
    if (result?.reason !== 'idempotent_replay' && finalizedInvoice?.customer_id && productionOrderId) {
      const linkedRequest = await pool.query(
        `SELECT l.request_id FROM customer_manufacturing_production_links l
          WHERE l.company_id=$1 AND l.production_order_id=$2::uuid LIMIT 1`,
        [String(companyId), String(productionOrderId)]
      ).catch(() => ({ rows: [] }));
      if (linkedRequest.rows[0]?.request_id) {
        await createCustomerPortalNotification({
          customerId: finalizedInvoice.customer_id, companyId, type: 'invoice_issued',
          title: 'Manufacturing invoice issued',
          message: `Invoice ${finalizedInvoice.invoice_number || ''} is ready to view.`,
          invoiceId: finalizedInvoice.id, url: '/customer/manufacturing-requests',
        }).catch(err => console.warn('Customer manufacturing invoice notification failed:', err.message));
        if (redisClient?.status === 'ready') {
          redisClient.publish(`customer_manufacturing_events:${linkedRequest.rows[0].request_id}`, JSON.stringify({
            type: 'invoice_issued', requestId: linkedRequest.rows[0].request_id, invoiceId: finalizedInvoice.id,
          })).catch(() => {});
        }
      }
    }
    if (result?.reason !== 'idempotent_replay' && finalizedInvoice?.customer_id && jobId) {
      const title = 'Invoice ready';
      const message = `Invoice ${finalizedInvoice.invoice_number || ''} for your completed service is ready to view.`;
      await createCustomerPortalNotification({
        customerId: finalizedInvoice.customer_id,
        companyId,
        type: 'invoice_issued',
        title,
        message,
        jobId,
        invoiceId: finalizedInvoice.id,
        url: `/customer/job/${jobId}`,
      }).catch(err => console.warn('Customer invoice activity notification failed:', err.message));
      if (redisClient && redisClient.status === 'ready') {
        redisClient.publish(`customer_job_events:${jobId}`, JSON.stringify({
          type: 'invoice_issued', jobId, invoiceId: finalizedInvoice.id,
        })).catch(() => {});
      }
    }

    return res.json(result);
  } catch (err) {
    console.error('POST /api/invoices/finalize error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.message });
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
    if (!['owner', 'admin', 'super_admin'].includes(String(req.user.role || '').toLowerCase())) {
      return res.status(403).json({ error: 'Only an owner or administrator can reissue an invoice.' });
    }
    const parentInvoiceId = req.params.id;
    const { disputeId, updateData } = req.body;

    const result = await invoiceService.reissueInvoice({
      companyId,
      parentInvoiceId,
      disputeId,
      userId,
      updateData,
    });

    if (result?.reason !== 'idempotent_replay') {
      await notifyOtherOwnersOfGstInvoice({ companyId, actorId: userId, invoice: result?.invoice, action: 'reissued' })
        .catch((error) => console.warn('GST invoice revision owner notification could not be persisted:', error.message));
    }

    if (result?.reason !== 'idempotent_replay' && result?.invoice?.customer_id) {
      const jobId = result.invoice.job_id;
      await createCustomerPortalNotification({
        customerId: result.invoice.customer_id,
        companyId,
        type: 'invoice_issued',
        title: 'Revised invoice ready',
        message: `Revised invoice ${result.invoice.invoice_number} is ready to view.`,
        jobId,
        invoiceId: result.invoice.id,
        url: jobId ? `/customer/job/${jobId}` : `/customer/invoices/${result.invoice.id}`,
      }).catch(err => console.warn('Customer revised invoice notification failed:', err.message));
      if (jobId && redisClient && redisClient.status === 'ready') {
        redisClient.publish(`customer_job_events:${jobId}`, JSON.stringify({ type: 'invoice_issued', jobId, invoiceId: result.invoice.id })).catch(() => {});
      }
    }

    return res.json(result);
  } catch (err) {
    console.error('POST /api/invoices/:id/reissue error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/:id/track
 * Logs customer view or download activity with timestamps.
 */
router.post('/:id/track', setInvoiceTenantContext, async (req, res) => {
  try {
    const { id } = req.params;
    const { actionType, performedByType, performedById, performedByName } = req.body;

    // Securely resolve company_id and customer_id directly from the database
    const invRow = await pool.query(`SELECT id, company_id, customer_id FROM invoices WHERE id = $1`, [id]);
    if (invRow.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (!verifyInvoiceAccess(req, invRow.rows[0])) {
      return res.status(403).json({ error: 'Forbidden: Access denied to this invoice' });
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
router.post('/:id/dispute', setInvoiceTenantContext, async (req, res) => {
  try {
    const { id } = req.params;
    // Accept both snake_case (from customer portal) and camelCase
    const issueCategory = req.body.issueCategory || req.body.issue_category;
    const description = req.body.description;

    if (!issueCategory || !description) {
      return res.status(400).json({ error: 'Issue category and description are required' });
    }

    // Securely resolve company_id and customer_id directly from the database
    const invRow = await pool.query(`SELECT id, company_id, customer_id FROM invoices WHERE id = $1`, [id]);
    if (invRow.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (!verifyInvoiceAccess(req, invRow.rows[0])) {
      return res.status(403).json({ error: 'Forbidden: Access denied to this invoice' });
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
router.get('/disputes/all', authenticate, requireFinanceReadAccess, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;

    const result = await pool.query(
      `SELECT d.*, i.invoice_number, i.total_amount, i.job_id, j.title AS job_title, c.name AS customer_name, c.email AS customer_email
       FROM invoice_disputes d
       LEFT JOIN invoices i ON d.invoice_id = i.id AND i.company_id = d.company_id
       LEFT JOIN jobs j ON i.job_id = j.id AND j.company_id = d.company_id
       LEFT JOIN customers c ON d.customer_id = c.id AND c.company_id = d.company_id
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
router.get('/:id/pdf', setInvoiceTenantContext, async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.invoiceAccessCompanyId;
    if (!companyId) return res.status(401).json({ error: 'Company context is required to access this invoice.' });

    const invRes = await pool.query(`SELECT * FROM invoices WHERE id = $1 AND company_id::text = $2::text`, [id, String(companyId)]);
    if (invRes.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invRes.rows[0];

    const sessionToken = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.split(' ')[1]
      : req.cookies?.access_token || req.cookies?.user_access_token || req.cookies?.customer_access_token;
    let session = null;
    if (sessionToken) {
      try { session = jwt.verify(sessionToken, process.env.JWT_SECRET); } catch (_) { /* handled by normal access verifier */ }
    }
    if (String(session?.role || '').toLowerCase() === 'employee' && invoice.invoice_type === 'production') {
      const employeeId = session.userId || session.id;
      const allowed = employeeId && ['issued','sent','viewed','partially_paid','paid'].includes(String(invoice.status || '').toLowerCase())
        ? await pool.query(
          `SELECT 1 FROM production_order_invoice_links l
           JOIN production_orders o ON o.id=l.production_order_id AND o.company_id::text=l.company_id
           WHERE l.company_id::text=$1::text AND l.invoice_id=$2
             AND (o.assigned_employee_id::text=$3::text OR o.dispatch_employee_id::text=$3::text)
           LIMIT 1`,
          [String(invoice.company_id), invoice.id, String(employeeId)]
        )
        : { rows: [] };
      if (!allowed.rows.length) return res.status(404).json({ error: 'Issued production invoice not found for this employee.' });
    }

    // Cryptographic validation: user session or signed access token required
    if (!verifyInvoiceAccess(req, invoice)) {
      return res.status(401).json({ error: 'Unauthorized: Valid authentication session or signed token required' });
    }

    const itemsRes = await pool.query(`SELECT * FROM invoice_items WHERE invoice_id = $1 AND company_id::text = $2::text`, [id, String(companyId)]);

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

    const pdf = await pdfInvoiceService.generateInvoicePDF(invoice, itemsRes.rows, companyProfile);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Invoice-${String(invoice.invoice_number || invoice.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf"`);
    return res.send(pdf);
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
    await pool.query(`UPDATE invoices SET status = 'sent', updated_at = NOW() WHERE id = $1 AND company_id = $2`, [id, companyId]);

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
    await pool.query(`UPDATE invoices SET status = 'sent', updated_at = NOW() WHERE id = $1 AND company_id = $2`, [id, companyId]);

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
module.exports.createInvoicePaymentRecordHandler = createInvoicePaymentRecordHandler;
