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

    // Attach decoded payload — downstream handlers use req.customer.id / req.customer.companyId
    req.customer = payload;
    next();
  });
}

module.exports = { authenticateCustomer };
