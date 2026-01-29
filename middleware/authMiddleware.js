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
  }

  if (!token) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    // Normalize payload: ensure both 'id' and 'userId' exist for compatibility
    req.user = {
      ...payload,
      id: payload.id || payload.userId,
      userId: payload.userId || payload.id
    };
    next();
  });
}

module.exports = { authenticateToken };
