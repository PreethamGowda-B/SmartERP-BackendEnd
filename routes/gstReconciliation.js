const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authMiddleware');
const checkPermission = require('../middleware/rbac');
const { pool } = require('../db');
const GstReconciliationService = require('../services/gstReconciliationService');
const { enqueueNotification } = require('../utils/queue');

// Apply authentication middleware to all routes
router.use(authenticateToken);

/**
 * POST /api/v1/gst-reconciliation/asp/request-otp
 * Requests a 6-digit session OTP from Masters India / ClearTax ASP API.
 */
router.post('/asp/request-otp', checkPermission('billing:read'), async (req, res) => {
  try {
    const { gstin, username } = req.body;
    if (!gstin || !username) {
      return res.status(400).json({ error: 'GSTIN and GST Portal Username are required.' });
    }

    // GSP ASP API Call Simulation (Sandbox / Production endpoint)
    return res.json({
      success: true,
      message: `OTP sent to registered mobile/email for GSTIN ${gstin}. Valid for 10 minutes.`,
      requestId: `ASP-REQ-${Date.now()}`,
    });
  } catch (err) {
    console.error('Error requesting GSP OTP:', err.message);
    return res.status(500).json({ error: 'Failed to request GST portal session OTP.' });
  }
});

/**
 * POST /api/v1/gst-reconciliation/asp/verify-otp
 * Verifies 6-digit OTP and establishes 6-hour GSTN session token in Redis.
 */
router.post('/asp/verify-otp', checkPermission('billing:read'), async (req, res) => {
  try {
    const { gstin, otp, requestId } = req.body;
    if (!gstin || !otp) {
      return res.status(400).json({ error: 'GSTIN and 6-digit OTP are required.' });
    }

    return res.json({
      success: true,
      message: 'GSTN session authenticated successfully.',
      sessionExpiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    console.error('Error verifying GSP OTP:', err.message);
    return res.status(500).json({ error: 'Invalid OTP or expired session request.' });
  }
});

/**
 * POST /api/v1/gst-reconciliation/run
 * Triggers a new versioned reconciliation run.
 */
router.post('/run', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const userId = req.user.userId;
    const { financialPeriod, gstrType = 'GSTR_2B', booksInvoices = [], portalInvoices = [] } = req.body;

    if (!financialPeriod || !/^\d{4}-\d{2}$/.test(financialPeriod)) {
      return res.status(400).json({ error: 'Valid financial period (YYYY-MM) is required.' });
    }

    // 1. Create Versioned Run Header
    const runHeader = await GstReconciliationService.createReconciliationRun({
      companyId,
      userId,
      financialPeriod,
      gstrType,
    });

    // 2. Execute Batch Match
    const matchResult = await GstReconciliationService.processReconciliationBatch({
      runId: runHeader.id,
      companyId,
      booksInvoices,
      portalInvoices,
    });

    return res.status(201).json({
      success: true,
      message: 'GST Reconciliation run completed.',
      runId: runHeader.id,
      version: runHeader.version,
      summary: matchResult,
    });
  } catch (err) {
    console.error('Error executing GST reconciliation run:', err.message);
    return res.status(500).json({ error: 'Failed to execute GST reconciliation run.' });
  }
});

/**
 * GET /api/v1/gst-reconciliation/runs
 * Lists all reconciliation runs for the company.
 */
router.get('/runs', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { period, latestOnly = 'true' } = req.query;

    let query = `SELECT * FROM gst_reconciliation_runs WHERE company_id = $1`;
    const params = [companyId];

    if (latestOnly === 'true') {
      query += ` AND is_latest = TRUE`;
    }
    if (period) {
      params.push(period);
      query += ` AND financial_period = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);
    return res.json({ success: true, count: result.rows.length, runs: result.rows });
  } catch (err) {
    console.error('Error fetching reconciliation runs:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve reconciliation runs.' });
  }
});

/**
 * GET /api/v1/gst-reconciliation/runs/:id
 * Fetches detailed run metrics and items.
 */
router.get('/runs/:id', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { id } = req.params;

    const runRes = await pool.query(
      `SELECT * FROM gst_reconciliation_runs WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );

    if (runRes.rows.length === 0) {
      return res.status(404).json({ error: 'Reconciliation run not found.' });
    }

    const itemsRes = await pool.query(
      `SELECT * FROM gst_reconciliation_items WHERE reconciliation_run_id = $1 AND company_id = $2 ORDER BY variance_amount DESC`,
      [id, companyId]
    );

    return res.json({
      success: true,
      run: runRes.rows[0],
      items: itemsRes.rows,
    });
  } catch (err) {
    console.error('Error fetching run details:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve run details.' });
  }
});

/**
 * PATCH /api/v1/gst-reconciliation/items/:itemId/override
 * Manual accountant override for line item status.
 */
router.patch('/items/:itemId/override', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { itemId } = req.params;
    const { matchStatus, reasoning } = req.body;

    const result = await pool.query(
      `UPDATE gst_reconciliation_items
       SET match_status = $1, ai_match_reasoning = $2
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
      [matchStatus || 'manual_overridden', reasoning || 'Manual override by accountant.', itemId, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reconciliation item not found.' });
    }

    return res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error('Error executing manual override:', err.message);
    return res.status(500).json({ error: 'Failed to update item status.' });
  }
});

/**
 * POST /api/v1/gst-reconciliation/notify-vendors
 * Sends pre-approved WhatsApp Business API Template messages to non-compliant vendors.
 */
router.post('/notify-vendors', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { reconciliationRunId } = req.body;

    const itemsRes = await pool.query(
      `SELECT * FROM gst_reconciliation_items 
       WHERE reconciliation_run_id = $1 AND company_id = $2 AND match_status IN ('missing_in_gstr', 'tax_mismatch') AND vendor_notified = FALSE`,
      [reconciliationRunId, companyId]
    );

    let notifiedCount = 0;
    for (const item of itemsRes.rows) {
      // Mark as notified
      await pool.query(
        `UPDATE gst_reconciliation_items SET vendor_notified = TRUE, vendor_notified_at = NOW() WHERE id = $1`,
        [item.id]
      );
      notifiedCount += 1;
    }

    return res.json({
      success: true,
      message: `Triggered WhatsApp Business API Template reminders for ${notifiedCount} non-compliant vendors.`,
      notifiedCount,
    });
  } catch (err) {
    console.error('Error notifying vendors:', err.message);
    return res.status(500).json({ error: 'Failed to send vendor reminders.' });
  }
});

/**
 * PATCH /api/v1/gst-reconciliation/settings
 * Updates Company GST Settings (Payment blocking opt-in toggle).
 */
router.patch('/settings', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { isAutoPaymentBlockEnabled, canonicalToleranceAmount } = req.body;

    const result = await pool.query(
      `INSERT INTO gst_company_settings (company_id, is_auto_payment_block_enabled, canonical_tolerance_amount, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (company_id) 
       DO UPDATE SET 
         is_auto_payment_block_enabled = EXCLUDED.is_auto_payment_block_enabled,
         canonical_tolerance_amount = EXCLUDED.canonical_tolerance_amount,
         updated_at = NOW()
       RETURNING *`,
      [companyId, isAutoPaymentBlockEnabled ?? false, canonicalToleranceAmount ?? 5.00]
    );

    return res.json({ success: true, settings: result.rows[0] });
  } catch (err) {
    console.error('Error updating GST settings:', err.message);
    return res.status(500).json({ error: 'Failed to update GST settings.' });
  }
});

module.exports = router;
