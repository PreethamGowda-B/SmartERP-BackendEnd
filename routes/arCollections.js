const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { checkPermission } = require('../middleware/rbac');
const { pool } = require('../db');
const ArCollectionsService = require('../services/arCollectionsService');

router.use(authenticateToken);

/**
 * GET /api/v1/ar-collections/summary
 * Fetches AR Aging Bucket breakdown metrics.
 */
router.get('/summary', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const summary = await ArCollectionsService.getAgingSummary(companyId);
    return res.json({ success: true, aging: summary });
  } catch (err) {
    console.error('Error fetching AR aging summary:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve AR aging summary.' });
  }
});

/**
 * POST /api/v1/ar-collections/sync
 * Syncs unpaid invoices into AR collection tracking schedules.
 */
router.post('/sync', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const syncRes = await ArCollectionsService.syncInvoicesToSchedules(companyId);
    return res.json({
      success: true,
      message: `Synced ${syncRes.syncedCount} unpaid invoices into AR collection tracking.`,
    });
  } catch (err) {
    console.error('Error syncing invoices to AR schedules:', err.message);
    return res.status(500).json({ error: 'Failed to sync invoices.' });
  }
});

/**
 * GET /api/v1/ar-collections/schedules
 * Lists AR collection schedules.
 */
router.get('/schedules', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { stage, paused } = req.query;

    let query = `SELECT * FROM ar_collection_schedules WHERE company_id = $1`;
    const params = [companyId];

    if (stage) {
      params.push(stage);
      query += ` AND current_stage = $${params.length}`;
    }
    if (paused !== undefined) {
      params.push(paused === 'true');
      query += ` AND is_paused = $${params.length}`;
    }

    query += ` ORDER BY amount_outstanding DESC`;

    const result = await pool.query(query, params);
    return res.json({ success: true, count: result.rows.length, schedules: result.rows });
  } catch (err) {
    console.error('Error fetching AR schedules:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve AR schedules.' });
  }
});

/**
 * POST /api/v1/ar-collections/dispatch-reminder
 * Dispatches a Meta WhatsApp Business API Template reminder.
 */
router.post('/dispatch-reminder', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { scheduleId, channel = 'whatsapp' } = req.body;

    if (!scheduleId) {
      return res.status(400).json({ error: 'Schedule ID is required.' });
    }

    const dispatchRes = await ArCollectionsService.dispatchReminder({ companyId, scheduleId, channel });
    return res.json({
      success: true,
      message: 'Meta WhatsApp Business API Template reminder dispatched.',
      log: dispatchRes.log,
    });
  } catch (err) {
    console.error('Error dispatching AR reminder:', err.message);
    return res.status(500).json({ error: 'Failed to send payment reminder.' });
  }
});

/**
 * PATCH /api/v1/ar-collections/schedules/:id/pause
 * Pauses automated reminders for a schedule.
 */
router.patch('/schedules/:id/pause', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE ar_collection_schedules SET is_paused = TRUE, updated_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Schedule not found.' });
    }

    return res.json({ success: true, schedule: result.rows[0] });
  } catch (err) {
    console.error('Error pausing AR schedule:', err.message);
    return res.status(500).json({ error: 'Failed to pause schedule.' });
  }
});

/**
 * PATCH /api/v1/ar-collections/schedules/:id/resume
 * Resumes automated reminders for a schedule.
 */
router.patch('/schedules/:id/resume', checkPermission('billing:read'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE ar_collection_schedules SET is_paused = FALSE, updated_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Schedule not found.' });
    }

    return res.json({ success: true, schedule: result.rows[0] });
  } catch (err) {
    console.error('Error resuming AR schedule:', err.message);
    return res.status(500).json({ error: 'Failed to resume schedule.' });
  }
});

/**
 * POST /api/v1/ar-collections/payment-plan-offer
 * Generates an AI payment plan offer.
 */
router.post('/payment-plan-offer', checkPermission('billing:read'), async (req, res) => {
  try {
    const { customerName, outstandingAmount, overdueDays } = req.body;
    const offer = await ArCollectionsService.generatePaymentPlanOffer({
      customerName: customerName || 'Valued Client',
      outstandingAmount: parseFloat(outstandingAmount || 10000),
      overdueDays: parseInt(overdueDays || 15, 10),
    });

    return res.json({ success: true, offer });
  } catch (err) {
    console.error('Error generating payment plan offer:', err.message);
    return res.status(500).json({ error: 'Failed to generate payment plan offer.' });
  }
});

module.exports = router;
