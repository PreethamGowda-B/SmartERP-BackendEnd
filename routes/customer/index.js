/**
 * routes/customer/index.js
 *
 * Root router for all /api/customer/* routes.
 * Mounts sub-routers and applies authenticateCustomer to protected routes.
 */

const express = require('express');
const router = express.Router();
const { authenticateCustomer } = require('../../middleware/customerAuthMiddleware');

// ── Public auth routes (no JWT required — handles its own auth internally) ────
router.use('/auth', require('./auth'));

// ── Protected routes — require valid customer JWT ─────────────────────────────
router.use('/jobs', authenticateCustomer, require('./jobs'));
router.use('/profile', authenticateCustomer, require('./profile'));
router.use('/recurring', authenticateCustomer, require('./recurring'));

// ── SSE route — authenticateCustomer is applied inside sse.js
// (SSE uses ?token= query param which requires auth inside the handler)
router.use('/', require('./sse'));

// ── Validate company — public convenience endpoint (also on auth router) ──────
// Mounted here so /api/customer/validate-company works without /auth prefix
router.get('/validate-company', async (req, res) => {
  const { pool } = require('../../db');
  const { code } = req.query;

  if (!code) {
    return res.json({ valid: false });
  }

  try {
    const result = await pool.query(
      'SELECT company_name FROM companies WHERE company_id = $1',
      [code]
    );

    if (result.rows.length === 0) {
      return res.json({ valid: false });
    }

    return res.json({ valid: true, companyName: result.rows[0].company_name });
  } catch (err) {
    console.error('validate-company error:', err.message);
    return res.json({ valid: false });
  }
});

module.exports = router;
