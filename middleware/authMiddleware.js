const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  // Try header first
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  // Fallback to cookie
  if (!token && req.cookies) {
    token = req.cookies.access_token;
  }

  if (!token) return res.status(401).json({ message: 'Not authenticated' });

  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return res.status(401).json({ message: 'Invalid or expired token' });
    req.user = payload; // payload.userId, payload.role
    next();
  });
}

module.exports = { authenticateToken };
