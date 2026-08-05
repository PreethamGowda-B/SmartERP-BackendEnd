const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/remote-support ────────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;
    const { customer_id, machine_id } = req.query;

    let query = `
      SELECT r.*, c.name as customer_name, m.machine_name, m.serial_number, u.name as engineer_name
      FROM remote_support_sessions r
      LEFT JOIN customers c ON r.customer_id::text = c.id::text
      LEFT JOIN customer_machines m ON r.machine_id::text = m.id::text
      LEFT JOIN users u ON r.engineer_id::text = u.id::text
      WHERE r.company_id::text = $1::text
    `;
    const params = [companyId];

    if (customer_id) {
      params.push(customer_id);
      query += ` AND r.customer_id::text = $${params.length}::text`;
    }

    if (machine_id) {
      params.push(machine_id);
      query += ` AND r.machine_id::text = $${params.length}::text`;
    }

    query += ` ORDER BY r.created_at DESC`;

    const result = await pool.query(query, params);
    res.json({ success: true, sessions: result.rows });
  } catch (err) {
    console.error('❌ Error fetching remote support sessions:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ─── POST /api/remote-support (Log Remote Support Session) ─────────────────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;
    const engineerId = req.user.userId || req.user.id;
    const { customer_id, machine_id, support_channel, duration_minutes = 15, resolution_summary, is_resolved = true } = req.body;

    if (!customer_id || !support_channel) {
      return res.status(400).json({ message: 'customer_id and support_channel are required' });
    }

    const status = is_resolved ? 'resolved' : 'unresolved_converted_to_job';

    const result = await pool.query(
      `INSERT INTO remote_support_sessions
         (company_id, customer_id, machine_id, engineer_id, support_channel, duration_minutes, resolution_summary, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING *`,
      [companyId, customer_id, machine_id || null, engineerId, support_channel, duration_minutes, resolution_summary || '', status]
    );

    const session = result.rows[0];

    // If unresolved, auto-convert to Breakdown Job for engineer dispatch!
    let job = null;
    if (!is_resolved) {
      const jobRes = await pool.query(
        `INSERT INTO jobs (title, description, customer_id, company_id, machine_id, service_type, priority, status, employee_status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'breakdown', 'high', 'open', 'pending', NOW(), NOW())
         RETURNING *`,
        [
          `[Unresolved Remote Support - ${support_channel}] Breakdown Dispatch`,
          `Remote support session (${duration_minutes}m) unresolved. Summary: ${resolution_summary}`,
          customer_id,
          companyId,
          machine_id || null,
        ]
      );
      job = jobRes.rows[0];

      await pool.query(
        `UPDATE remote_support_sessions SET job_id = $1 WHERE id = $2`,
        [job.id, session.id]
      );
    }

    res.status(201).json({ success: true, session, job });
  } catch (err) {
    console.error('❌ Error logging remote support:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
