/**
 * middleware/customerAuthMiddleware.js
 *
 * Dedicated authentication middleware for the Customer Portal.
 * Verifies the JWT, asserts role === 'customer', and populates req.customer.
 * Completely separate from authenticateToken (which handles owner/employee/hr).
 *
 * Token extraction order:
 *   1. customer_access_token HttpOnly cookie  (primary)
 *   2. Authorization: Bearer <token> header   (API client fallback)
 *
 * NOTE: The ?token= query param fallback has been intentionally removed from
 * this shared middleware. SSE connections use their own authenticateSSE function
 * in routes/customer/sse.js which handles the query param fallback safely.
 */

const jwt = require('jsonwebtoken');
const { storage } = require('./als');

function authenticateCustomer(req, res, next) {
  let token = null;

  // 1. HttpOnly cookie (primary — set by login/refresh endpoints)
  if (req.cookies && req.cookies.customer_access_token) {
    token = req.cookies.customer_access_token;
  }

  // 2. Authorization: Bearer header (fallback for API clients / onboarding flow)
  if (!token) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }

    // Strict role check — only 'customer' tokens are accepted here
    // This prevents owner/employee JWTs from accessing customer routes
    if (payload.role !== 'customer') {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Normalize legacy claim spellings once at the auth boundary. Several older
    // customer tokens carry customerId/userId or company_id instead of id/companyId.
    // Downstream customer routes consistently consume id and companyId.
    const customerId = payload.id || payload.customerId || payload.userId;
    const companyId = payload.companyId || payload.company_id;
    req.customer = { ...payload, id: customerId, companyId };

    // Customer requests need the same tenant-scoped RLS context as owner and
    // employee requests. Without this, INSERTs into FORCE-RLS tables such as
    // jobs are rejected even when the row belongs to the customer's company.
    storage.run({
      isWebRequest: true,
      companyId,
      role: 'customer',
      userId: customerId,
      bypassRls: false,
    }, next);
  });
}

module.exports = { authenticateCustomer };
