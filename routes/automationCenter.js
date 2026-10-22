const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { evaluateAutomationRules, SUPPORTED_AUTOMATION_ACTIONS } = require('../helpers/evaluateAutomations');
const { emitSystemEvent } = require('../helpers/eventBus');

// ─── GET /api/automation-center (Fetch Active Zero-Code Rules) ─────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && req.user.role !== 'super_admin') {
      return res.json({ success: true, rules: [] });
    }

    const result = await pool.query(
      `SELECT * FROM automation_rules WHERE company_id::text = $1::text ORDER BY created_at DESC`,
      [companyId.toString()]
    ).catch(() => ({ rows: [] }));

    res.json({ success: true, rules: result.rows });
  } catch (err) {
    console.error('❌ Error fetching automation rules:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── POST /api/automation-center (Create Zero-Code Automation Rule) ───────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) return res.status(403).json({ message: 'No company associated with this account' });
    const { rule_name, trigger_event, action_type } = req.body;

    if (typeof rule_name !== 'string' || !rule_name.trim() || typeof trigger_event !== 'string' || !trigger_event.trim() || typeof action_type !== 'string') {
      return res.status(400).json({ message: 'rule_name, trigger_event, and action_type are required' });
    }
    if (!SUPPORTED_AUTOMATION_ACTIONS.includes(action_type)) {
      return res.status(400).json({
        success: false,
        code: 'UNSUPPORTED_AUTOMATION_ACTION',
        message: 'This automation action is not supported.',
      });
    }

    const result = await pool.query(
      `INSERT INTO automation_rules (company_id, rule_name, trigger_event, action_type, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, NOW(), NOW())
       RETURNING *`,
      [companyId.toString(), rule_name, trigger_event, action_type]
    );

    const newRule = result.rows[0];

    await emitSystemEvent('AUTOMATION_RULE_CREATED', {
      companyId,
      userId: req.user.id || req.user.userId,
      action: `Created Automation Rule: ${rule_name}`,
      details: { trigger_event, action_type },
    });

    res.status(201).json({ success: true, rule: newRule });
  } catch (err) {
    console.error('Automation rule creation failed:', err?.code || 'DATABASE_ERROR');
    res.status(500).json({ message: 'Failed to save automation rule.' });
  }
});

// ─── POST /api/automation-center/evaluate (Trigger Rule Evaluation Manually) ─
router.post('/evaluate', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId) return res.status(403).json({ message: 'No company associated with this account' });
    const { trigger_event, jobId, machineId, itemId, details } = req.body;

    if (!trigger_event) {
      return res.status(400).json({ message: 'trigger_event is required' });
    }

    const outcome = await evaluateAutomationRules(trigger_event, { companyId, jobId, machineId, itemId, details });
    return res.status(outcome.success ? 200 : 207).json({
      success: outcome.success,
      message: outcome.success ? `Automation rules evaluated for event ${trigger_event}` : 'One or more automation actions failed.',
      results: outcome.results,
    });
  } catch (err) {
    console.error('Automation rule evaluation failed:', err?.code || 'DATABASE_ERROR');
    res.status(500).json({ success: false, message: 'Failed to evaluate automation rules.' });
  }
});

module.exports = router;
