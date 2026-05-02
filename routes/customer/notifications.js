const express = require('express');
const router = express.Router();
const { pool } = require('../../db');

router.get('/', async (req, res) => {
  const customerId = req.customer.id;
  const companyId = req.customer.companyId;
  const limit = Math.min(50, parseInt(req.query.limit) || 20);

  try {
    const result = await pool.query(
      `SELECT id, action AS type, details, created_at
       FROM activities
       WHERE activity_type = 'customer_notification'
         AND company_id = $1
         AND details::jsonb->>'customer_id' = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [companyId, customerId, limit]
    );

    return res.json({ success: true, data: result.rows, error: null });
  } catch (err) {
    console.error('Customer notifications error:', err);
    return res.status(500).json({ success: false, data: null, error: 'Server error' });
  }
});

module.exports = router;
