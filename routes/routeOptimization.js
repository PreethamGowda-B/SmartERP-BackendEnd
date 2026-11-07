const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

function validateRouteOptimizationRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, message: 'A route request is required.' };
  }
  if (!Array.isArray(body.stops) || body.stops.length < 2 || body.stops.some((stop) => typeof stop !== 'string' || !stop.trim())) {
    return { valid: false, message: 'At least two non-empty stop locations are required.' };
  }
  if (body.engineer_name !== undefined && (typeof body.engineer_name !== 'string' || !body.engineer_name.trim())) {
    return { valid: false, message: 'engineer_name must be a non-empty string when provided.' };
  }
  return { valid: true };
}

function handleRouteOptimization(req, res) {
  const validation = validateRouteOptimizationRequest(req.body);
  if (!validation.valid) {
    return res.status(400).json({ success: false, message: validation.message });
  }

  return res.status(501).json({
    success: false,
    code: 'ROUTE_OPTIMIZATION_UNAVAILABLE',
    message: 'Route optimization is unavailable because no routing provider is configured.',
  });
}

// GET /api/route-optimization: returns active technician dispatches for the company
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id;
    if (!companyId && req.user.role !== 'super_admin') {
      return res.json({ success: true, active_dispatches: [] });
    }

    // Fetch active service jobs with technician assignment
    const jobsRes = await pool.query(
      `SELECT j.id, j.title, j.status, j.priority, j.created_at,
              COALESCE(u.name, 'Field Engineer') as engineer_name,
              COALESCE(c.name, 'Customer Plant') as customer_name,
              COALESCE(c.address, 'Customer Site') as customer_address
       FROM jobs j
       LEFT JOIN users u ON j.assigned_to::text = u.id::text
       LEFT JOIN customers c ON j.customer_id::text = c.id::text
       WHERE j.company_id::text = $1::text
         AND j.status IN ('active', 'in_progress', 'open', 'assigned')
       ORDER BY j.created_at DESC
       LIMIT 10`,
      [String(companyId)]
    ).catch(() => ({ rows: [] }));

    res.json({
      success: true,
      active_dispatches: jobsRes.rows.map(j => ({
        job_id: j.id,
        job_title: j.title,
        engineer_name: j.engineer_name,
        customer_name: j.customer_name,
        location: j.customer_address,
        priority: j.priority,
        status: j.status,
      })),
    });
  } catch (err) {
    res.json({ success: true, active_dispatches: [] });
  }
});

router.post('/', authenticateToken, handleRouteOptimization);

module.exports = router;
module.exports.validateRouteOptimizationRequest = validateRouteOptimizationRequest;
module.exports.handleRouteOptimization = handleRouteOptimization;
