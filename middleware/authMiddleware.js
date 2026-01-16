const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
  let token = null;

  // Authorization header
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }

  // Cookie fallback
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

    // ✅ FIX: normalize payload
    req.user = {
      id: payload.userId,
      role: payload.role
    };

    next();
  });
}

module.exports = { authenticateToken };
