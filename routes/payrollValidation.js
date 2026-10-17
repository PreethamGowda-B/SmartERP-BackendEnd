const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { checkPermission } = require('../middleware/rbac');
const PayrollValidationService = require('../services/payrollValidationService');

router.use(authenticateToken);

/**
 * POST /api/v1/payroll/validate-pre-run
 * Executes 7-point audit checks for a month/year.
 */
router.post('/validate-pre-run', checkPermission('payroll:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const userId = req.user.userId || req.user.id;
    const { month, year } = req.body || {};

    if (!['owner', 'admin'].includes(String(req.user.role || '').toLowerCase())) {
      return res.status(403).json({ error: 'Only owners or payroll administrators can run this audit.' });
    }
    if (!companyId || !userId) {
      return res.status(401).json({ error: 'Company and user context are required.' });
    }
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ error: 'Month must be 1–12 and year must be between 2000 and 2100.' });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'proposedPayroll')) {
      return res.status(400).json({ error: 'Payroll audit data is loaded from persisted company payroll records.' });
    }

    const valResult = await PayrollValidationService.runPreRunValidation({
      companyId,
      userId,
      month,
      year,
    });

    return res.status(201).json({ success: true, validation: valResult });
  } catch (err) {
    console.error('Error executing pre-run validation:', err.code || err.message);
    return res.status(500).json({ error: 'Unable to execute payroll validation against persisted records.' });
  }
});

/**
 * GET /api/v1/payroll/validation-runs/:id
 * Fetches pre-run validation details and anomaly flags.
 */
router.get('/validation-runs/:id', checkPermission('payroll:write'), async (req, res) => {
  try {
    if (!['owner', 'admin'].includes(String(req.user.role || '').toLowerCase())) {
      return res.status(403).json({ error: 'Only owners or payroll administrators can view payroll audits.' });
    }
    const companyId = req.user.companyId;
    const { id } = req.params;
    if (!companyId) return res.status(401).json({ error: 'Company context is required.' });
    const details = await PayrollValidationService.getRunDetails({ companyId, runId: id });
    if (!details) {
      return res.status(404).json({ error: 'Validation run not found.' });
    }
    return res.json({ success: true, run: details.run, flags: details.flags });
  } catch (err) {
    console.error('Error fetching validation run details:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve validation run details.' });
  }
});

/**
 * PATCH /api/v1/payroll/validation-flags/:id/resolve
 * Resolves/overrides an anomaly flag with audit notes.
 */
router.patch('/validation-flags/:id/resolve', checkPermission('payroll:write'), async (req, res) => {
  try {
    if (!['owner', 'admin'].includes(String(req.user.role || '').toLowerCase())) {
      return res.status(403).json({ error: 'Only owners or payroll administrators can resolve payroll findings.' });
    }
    const companyId = req.user.companyId;
    const userId = req.user.userId;
    const { id } = req.params;
    const { resolutionNotes } = req.body || {};
    if (typeof resolutionNotes !== 'string' || resolutionNotes.trim().length < 8 || resolutionNotes.length > 1000) {
      return res.status(400).json({ error: 'A resolution note between 8 and 1000 characters is required.' });
    }

    const flag = await PayrollValidationService.resolveFlag({
      companyId,
      userId,
      flagId: id,
      resolutionNotes: resolutionNotes.trim(),
    });

    if (!flag) {
      return res.status(404).json({ error: 'Validation flag not found.' });
    }

    return res.json({ success: true, flag });
  } catch (err) {
    console.error('Error resolving flag:', err.message);
    return res.status(500).json({ error: 'Failed to resolve validation flag.' });
  }
});

/**
 * POST /api/v1/payroll/approve-pre-run
 * Approves a pre-run validation run, unblocking payroll creation.
 */
router.post('/approve-pre-run', checkPermission('payroll:write'), async (req, res) => {
  try {
    if (!['owner', 'admin'].includes(String(req.user.role || '').toLowerCase())) {
      return res.status(403).json({ error: 'Only owners or payroll administrators can approve payroll audits.' });
    }
    const companyId = req.user.companyId;
    const userId = req.user.userId;
    const { runId } = req.body;

    if (!runId) {
      return res.status(400).json({ error: 'Validation Run ID is required.' });
    }

    const approvedRun = await PayrollValidationService.approveRun({ companyId, userId, runId });
    return res.json({ success: true, message: 'Pre-run validation approved.', run: approvedRun });
  } catch (err) {
    console.error('Error approving pre-run validation:', err.message);
    return res.status(err.statusCode || 400).json({ error: err.message || 'Failed to approve pre-run validation.' });
  }
});

module.exports = router;
