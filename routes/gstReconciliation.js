const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { pool } = require('../db');
const GstReconciliationService = require('../services/gstReconciliationService');
const { normalizeGstr2b } = require('../services/gstr2bParser');
const auditService = require('../services/auditService');

// Apply authentication middleware to all routes
router.use(authenticateToken);

function requireCompanyFinanceRole(req, res) {
  const role = String(req.user?.role || '').toLowerCase();
  if (!['owner', 'admin'].includes(role)) {
    res.status(403).json({ error: 'Only company owners and administrators can manage GST reconciliation.' });
    return false;
  }
  if (!req.user?.companyId && !req.user?.company_id) {
    res.status(401).json({ error: 'Company context is required.' });
    return false;
  }
  return true;
}

function validPeriod(period) {
  return typeof period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
}

/**
 * POST /api/v1/gst-reconciliation/asp/request-otp
 * Requests a 6-digit session OTP from Masters India / ClearTax ASP API.
 */
router.post('/asp/request-otp', async (req, res) => {
  if (!requireCompanyFinanceRole(req, res)) return;
  return res.status(501).json({ error: 'GST portal authentication is unavailable because no verified GSTN/GSP integration is configured.' });
});

/**
 * POST /api/v1/gst-reconciliation/asp/verify-otp
 * Verifies 6-digit OTP and establishes 6-hour GSTN session token in Redis.
 */
router.post('/asp/verify-otp', async (req, res) => {
  if (!requireCompanyFinanceRole(req, res)) return;
  return res.status(501).json({ error: 'GST portal authentication is unavailable because no verified GSTN/GSP integration is configured.' });
});

router.get('/books-invoices', async (req, res) => {
  if (!requireCompanyFinanceRole(req, res)) return;
  const financialPeriod = String(req.query.period || '');
  if (!validPeriod(financialPeriod)) return res.status(400).json({ error: 'Valid financial period (YYYY-MM) is required.' });
  try {
    const invoices = await GstReconciliationService.getVerifiedPurchaseInvoices({
      companyId: req.user.companyId || req.user.company_id,
      financialPeriod,
    });
    return res.json({ success: true, financialPeriod, count: invoices.length, invoices });
  } catch (err) {
    console.error('Error fetching verified purchase invoices for GST reconciliation:', err.message);
    return res.status(500).json({ error: 'Could not load verified purchase bills for this period.' });
  }
});

/**
 * POST /api/v1/gst-reconciliation/run
 * Triggers a new versioned reconciliation run.
 */
router.post(['/run', '/runs'], async (req, res) => {
  if (!requireCompanyFinanceRole(req, res)) return;
  let runId = null;
  const companyId = req.user.companyId || req.user.company_id;
  const userId = req.user.userId || req.user.id;
  try {
    const { financialPeriod, gstrType = 'GSTR_2B', portalData } = req.body || {};

    if (!validPeriod(financialPeriod)) {
      return res.status(400).json({ error: 'Valid financial period (YYYY-MM) is required.' });
    }
    if (!['GSTR_2A', 'GSTR_2B'].includes(gstrType)) return res.status(400).json({ error: 'GSTR type must be GSTR_2A or GSTR_2B.' });
    if (!userId) return res.status(401).json({ error: 'User context is required.' });

    if (portalData === undefined) return res.status(400).json({ error: 'Upload a supported GSTR statement. Books invoices are loaded from verified company purchase bills.' });
    let portalInvoices;
    try {
      portalInvoices = normalizeGstr2b(portalData);
    } catch (parseError) {
      return res.status(400).json({ error: parseError.message || 'The uploaded GSTR statement is not supported.' });
    }
    const booksInvoices = await GstReconciliationService.getVerifiedPurchaseInvoices({ companyId, financialPeriod });
    if (booksInvoices.length > 5000 || portalInvoices.length > 5000) {
      return res.status(413).json({ error: 'A reconciliation run is limited to 5,000 invoices per source.' });
    }
    if (portalInvoices.length === 0) return res.status(400).json({ error: 'The uploaded statement contains no supported invoice rows.' });

    const runHeader = await GstReconciliationService.createReconciliationRun({
      companyId,
      userId,
      financialPeriod,
      gstrType,
    });
    runId = runHeader.id;

    const matchResult = await GstReconciliationService.processReconciliationBatch({
      runId,
      companyId,
      booksInvoices,
      portalInvoices,
    });

    const notificationResult = await GstReconciliationService.notifyOwners({
      companyId, actorId: userId, type: 'gst_reconciliation_completed',
      title: 'GST reconciliation completed',
      message: `The ${financialPeriod} ${gstrType} reconciliation finished with ${matchResult.totalMismatched} unmatched or mismatched purchase bills.`,
      idempotencyKey: `gst-reconciliation:${runId}:completed`, runId,
    }).catch((error) => {
      console.error('GST reconciliation completed, but owner notification persistence failed:', error.message);
      return { recipients: 0, persisted: 0, failures: 1 };
    });

    return res.status(201).json({
      success: true,
      message: 'GST Reconciliation run completed.',
      runId,
      version: runHeader.version,
      summary: matchResult,
      notification: { persisted: notificationResult.persisted, failures: notificationResult.failures },
    });
  } catch (err) {
    console.error('Error executing GST reconciliation run:', err.message);
    if (runId) {
      await GstReconciliationService.notifyOwners({
        companyId, actorId: userId, type: 'gst_reconciliation_failed',
        title: 'GST reconciliation failed',
        message: `The ${String(req.body?.financialPeriod || 'selected period')} reconciliation failed. No completed result is available.`,
        idempotencyKey: `gst-reconciliation:${runId}:failed`, runId,
      }).catch((notificationError) => console.error('GST reconciliation failure notification could not be persisted:', notificationError.message));
    }
    return res.status(500).json({ error: 'Failed to execute GST reconciliation run.' });
  }
});

/**
 * GET /api/v1/gst-reconciliation/runs
 * Lists all reconciliation runs for the company.
 */
router.get('/runs', async (req, res) => {
  if (!requireCompanyFinanceRole(req, res)) return;
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { period, latestOnly = 'true' } = req.query;
    if (period && !validPeriod(String(period))) return res.status(400).json({ error: 'Period must be in YYYY-MM format.' });

    let query = `SELECT * FROM gst_reconciliation_runs WHERE company_id::text = $1::text`;
    const params = [String(companyId)];

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
router.get('/runs/:id', async (req, res) => {
  if (!requireCompanyFinanceRole(req, res)) return;
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { id } = req.params;

    const runRes = await pool.query(
      `SELECT * FROM gst_reconciliation_runs WHERE id = $1 AND company_id::text = $2::text`,
      [id, String(companyId)]
    );

    if (runRes.rows.length === 0) {
      return res.status(404).json({ error: 'Reconciliation run not found.' });
    }

    const itemsRes = await pool.query(
      `SELECT * FROM gst_reconciliation_items WHERE reconciliation_run_id = $1 AND company_id::text = $2::text ORDER BY variance_amount DESC`,
      [id, String(companyId)]
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
router.patch('/items/:itemId/override', async (req, res) => {
  if (!requireCompanyFinanceRole(req, res)) return;
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { itemId } = req.params;
    const { matchStatus, reasoning } = req.body;
    const allowedStatuses = ['exact_match', 'fuzzy_match', 'tax_mismatch', 'missing_in_gstr', 'missing_in_books', 'manual_overridden'];
    if (!allowedStatuses.includes(matchStatus) || typeof reasoning !== 'string' || reasoning.trim().length < 4 || reasoning.length > 1000) {
      return res.status(400).json({ error: 'A valid reconciliation status and a review note are required.' });
    }

    const result = await pool.query(
      `UPDATE gst_reconciliation_items
       SET match_status = $1, ai_match_reasoning = $2
       WHERE id = $3 AND company_id::text = $4::text
       RETURNING *`,
      [matchStatus, reasoning.trim(), itemId, String(companyId)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reconciliation item not found.' });
    }

    auditService.logFromRequest(req, {
      companyId, userId: req.user.userId || req.user.id,
      actionType: 'gst_reconciliation_item_overridden', entityType: 'gst_reconciliation_item', entityId: itemId,
      newValue: { match_status: matchStatus, reasoning: reasoning.trim() },
    });

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
router.post('/notify-vendors', async (req, res) => {
  if (!requireCompanyFinanceRole(req, res)) return;
  return res.status(501).json({ error: 'Vendor reminders are unavailable: the reconciliation records do not include verified supplier contact details and no GST reminder delivery workflow is configured.' });
});

/**
 * PATCH /api/v1/gst-reconciliation/settings
 * Updates Company GST Settings (Payment blocking opt-in toggle).
 */
router.patch('/settings', async (req, res) => {
  if (!requireCompanyFinanceRole(req, res)) return;
  try {
    const companyId = req.user.companyId || req.user.company_id;
    const { isAutoPaymentBlockEnabled, canonicalToleranceAmount } = req.body;
    if (isAutoPaymentBlockEnabled !== undefined && typeof isAutoPaymentBlockEnabled !== 'boolean') {
      return res.status(400).json({ error: 'isAutoPaymentBlockEnabled must be a boolean.' });
    }
    if (canonicalToleranceAmount !== undefined && (!Number.isFinite(Number(canonicalToleranceAmount)) || Number(canonicalToleranceAmount) < 0 || Number(canonicalToleranceAmount) > 100000)) {
      return res.status(400).json({ error: 'canonicalToleranceAmount must be between 0 and 100000.' });
    }

    const result = await pool.query(
      `INSERT INTO gst_company_settings (company_id, is_auto_payment_block_enabled, canonical_tolerance_amount, updated_at)
       VALUES ($1, COALESCE($2, FALSE), COALESCE($3, 5.00), NOW())
       ON CONFLICT (company_id) 
       DO UPDATE SET 
         is_auto_payment_block_enabled = COALESCE($2, gst_company_settings.is_auto_payment_block_enabled),
         canonical_tolerance_amount = COALESCE($3, gst_company_settings.canonical_tolerance_amount),
         updated_at = NOW()
       RETURNING *`,
      [String(companyId), isAutoPaymentBlockEnabled ?? null, canonicalToleranceAmount === undefined ? null : Number(canonicalToleranceAmount)]
    );

    auditService.logFromRequest(req, {
      companyId, userId: req.user.userId || req.user.id,
      actionType: 'gst_reconciliation_settings_updated', entityType: 'gst_company_settings', entityId: companyId,
      newValue: { is_auto_payment_block_enabled: result.rows[0].is_auto_payment_block_enabled, canonical_tolerance_amount: result.rows[0].canonical_tolerance_amount },
    });

    return res.json({ success: true, settings: result.rows[0] });
  } catch (err) {
    console.error('Error updating GST settings:', err.message);
    return res.status(500).json({ error: 'Failed to update GST settings.' });
  }
});

module.exports = router;
