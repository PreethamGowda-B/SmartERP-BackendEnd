const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { checkPermission } = require('../middleware/rbac');
const { pool } = require('../db');
const PayrollValidationService = require('../services/payrollValidationService');

router.use(authenticateToken);

/**
 * POST /api/v1/payroll/validate-pre-run
 * Executes 7-point audit checks for a month/year.
 */
router.post('/validate-pre-run', checkPermission('payroll:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const userId = req.user.userId;
    const { month, year, proposedPayroll = [] } = req.body;

    if (!month || !year) {
      return res.status(400).json({ error: 'Month and Year are required.' });
    }

    const valResult = await PayrollValidationService.runPreRunValidation({
      companyId,
      userId,
      month: parseInt(month, 10),
      year: parseInt(year, 10),
      proposedPayroll,
    });

    return res.status(201).json({ success: true, validation: valResult });
  } catch (err) {
    console.error('Error executing pre-run validation:', err.message);
    return res.status(500).json({ error: 'Failed to execute pre-run payroll validation.' });
  }
});

/**
 * GET /api/v1/payroll/validation-runs/:id
 * Fetches pre-run validation details and anomaly flags.
 */
router.get('/validation-runs/:id', checkPermission('payroll:write'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { id } = req.params;

    const runRes = await pool.query(
      `SELECT * FROM payroll_validation_runs WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );

    if (runRes.rows.length === 0) {
      return res.status(404).json({ error: 'Validation run not found.' });
    }

    const flagsRes = await pool.query(
      `SELECT * FROM payroll_validation_flags WHERE validation_run_id = $1 AND company_id = $2 ORDER BY severity DESC, created_at DESC`,
      [id, companyId]
    );

    return res.json({
      success: true,
      run: runRes.rows[0],
      flags: flagsRes.rows,
    });
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
    const companyId = req.user.companyId;
    const userId = req.user.userId;
    const { id } = req.params;
    const { resolutionNotes } = req.body;

    const flag = await PayrollValidationService.resolveFlag({
      companyId,
      userId,
      flagId: id,
      resolutionNotes,
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
    return res.status(400).json({ error: err.message || 'Failed to approve pre-run validation.' });
  }
});

module.exports = router;
