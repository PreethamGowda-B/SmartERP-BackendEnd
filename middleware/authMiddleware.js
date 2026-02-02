const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
  let token = null;

  // Try Authorization header first
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }

  // Fallback to cookie
  if (!token && req.cookies) {
    token = req.cookies.access_token;
    console.log("🍪 Cookie token found:", token ? "YES" : "NO", "| Cookies:", Object.keys(req.cookies));
  }

  if (!token) {
    console.log("❌ No token found in request from:", req.headers.origin || req.headers.host);
    return res.status(401).json({ message: "Not authenticated" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    req.user = payload;
    next();
  });
}

module.exports = { authenticateToken };
