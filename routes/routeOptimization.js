const express = require('express');
const router = express.Router();
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
    message: 'Route optimization is not available yet. No route was calculated or saved.',
  });
}

router.post('/', authenticateToken, handleRouteOptimization);

module.exports = router;
module.exports.validateRouteOptimizationRequest = validateRouteOptimizationRequest;
module.exports.handleRouteOptimization = handleRouteOptimization;
