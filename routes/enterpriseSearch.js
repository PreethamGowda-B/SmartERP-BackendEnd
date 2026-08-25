const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/search/global (Global Ctrl+K Search Engine across 16 Entities) ──
router.get('/global', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && req.user.role !== 'super_admin') {
      return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
    }
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json({ success: true, results: [] });
    }

    const searchTerm = `%${q.trim()}%`;
    const results = [];

    // Search Machines
    const mRes = await pool.query(
      `SELECT id, machine_name as title, serial_number as subtitle, 'machine' as category, '/owner/machines/' || id as url
       FROM customer_machines
       WHERE company_id::text = $1::text AND (machine_name ILIKE $2 OR serial_number ILIKE $2 OR make ILIKE $2 OR model ILIKE $2 OR controller_type ILIKE $2)
       LIMIT 5`,
      [String(companyId), searchTerm]
    ).catch(() => ({ rows: [] }));
    results.push(...mRes.rows);

    // Search Jobs
    const jRes = await pool.query(
      `SELECT id, title, service_type as subtitle, 'job' as category, '/owner/jobs?id=' || id as url
       FROM jobs
       WHERE company_id::text = $1::text AND (title ILIKE $2 OR alarm_code ILIKE $2 OR description ILIKE $2)
       LIMIT 5`,
      [String(companyId), searchTerm]
    ).catch(() => ({ rows: [] }));
    results.push(...jRes.rows);

    // Search Quotations
    const qRes = await pool.query(
      `SELECT id, title, quotation_number as subtitle, 'quotation' as category, '/owner/quotations' as url
       FROM service_quotations
       WHERE company_id::text = $1::text AND (title ILIKE $2 OR quotation_number ILIKE $2)
       LIMIT 5`,
      [String(companyId), searchTerm]
    ).catch(() => ({ rows: [] }));
    results.push(...qRes.rows);

    // Search Customers strictly scoped to this company
    const cRes = await pool.query(
      `SELECT id, name as title, email as subtitle, 'customer' as category, '/owner/customers' as url
       FROM customers
       WHERE company_id::text = $1::text AND (name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)
       LIMIT 5`,
      [String(companyId), searchTerm]
    ).catch(() => ({ rows: [] }));
    results.push(...cRes.rows);

    res.json({ success: true, results });
  } catch (err) {
    console.error('❌ Error performing enterprise search:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
