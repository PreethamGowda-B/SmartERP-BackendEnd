const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/automation-center (Fetch Active Zero-Code Rules) ─────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;

    const result = await pool.query(
      `SELECT * FROM automation_rules WHERE company_id::text = $1::text ORDER BY created_at DESC`,
      [companyId]
    );

    res.json({ success: true, rules: result.rows });
  } catch (err) {
    console.error('❌ Error fetching automation rules:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── POST /api/automation-center (Create Zero-Code Automation Rule) ───────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;
    const { rule_name, trigger_event, action_type } = req.body;

    if (!rule_name || !trigger_event || !action_type) {
      return res.status(400).json({ message: 'rule_name, trigger_event, and action_type are required' });
    }

    const result = await pool.query(
      `INSERT INTO automation_rules (company_id, rule_name, trigger_event, action_type, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, NOW(), NOW())
       RETURNING *`,
      [companyId, rule_name, trigger_event, action_type]
    );

    res.status(201).json({ success: true, rule: result.rows[0] });
  } catch (err) {
    console.error('❌ Error creating automation rule:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
