const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
  let token = null;

  // Try Authorization header first
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }

  // Try query parameter (for SSE connections)
  if (!token && req.query && req.query.token) {
    token = req.query.token;
    console.log("🔗 Query token found for SSE connection");
  }

  // Fallback to cookie
  if (!token && req.cookies) {
    token = req.cookies.access_token;
    console.log("🍪 Cookie token found:", token ? "YES" : "NO", "| Cookies:", Object.keys(req.cookies));
  }

  if (!token) {
    console.log(`❌ No token found in ${req.method} ${req.path} from: ${req.headers.origin || req.headers.host}`);
    return res.status(401).json({ message: "Not authenticated" });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, payload) => {
    if (err) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    req.user = payload;

    // Set tenant context for RLS if companyId is present
    if (payload.companyId) {
      const { pool } = require("../db");
      try {
        // We use a middleware-level trick or just ensure subsequent pool.query uses the session
        // However, standard pool.query uses a random client. 
        // For RLS to work, we'll need to use the tenantQuery helper or a specific client.
      } catch (e) {
        console.error("Error setting tenant context:", e.message);
      }
    }
    next();
  });
}

module.exports = { authenticateToken };
