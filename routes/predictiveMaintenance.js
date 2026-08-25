const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/ai/predictive-maintenance (AI Failure Probability Scoring) ────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && req.user.role !== 'super_admin') {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }

    const query = req.user.role === 'super_admin'
      ? `SELECT m.id, m.machine_name, m.serial_number, m.make, m.model, m.controller_type, m.health_score, m.spindle_hours, c.name as customer_name
         FROM customer_machines m
         LEFT JOIN customers c ON m.customer_id::text = c.id::text
         ORDER BY m.health_score ASC`
      : `SELECT m.id, m.machine_name, m.serial_number, m.make, m.model, m.controller_type, m.health_score, m.spindle_hours, c.name as customer_name
         FROM customer_machines m
         LEFT JOIN customers c ON m.customer_id::text = c.id::text
         WHERE m.company_id::text = $1::text
         ORDER BY m.health_score ASC`;

    const params = req.user.role === 'super_admin' ? [] : [String(companyId)];
    const result = await pool.query(query, params);

    const predictions = result.rows.map((m) => {
      const breakdownRisk = Math.min(95, Math.max(10, 100 - (m.health_score || 100) + Math.floor((m.spindle_hours || 0) / 500)));
      return {
        ...m,
        breakdown_risk_percentage: breakdownRisk,
        recommended_pm_date: new Date(Date.now() + (100 - breakdownRisk) * 86400000).toISOString().split('T')[0],
        recommended_spares: breakdownRisk > 50 ? ['Spindle Oil Filter', 'Cooling Fan 24V', 'Encoder Cable'] : ['Standard PM Lubricant'],
      };
    });

    res.json({ success: true, predictions });
  } catch (err) {
    console.error('❌ Error fetching predictive maintenance analytics:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
