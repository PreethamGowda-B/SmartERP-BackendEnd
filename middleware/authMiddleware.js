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

  // Fallback to cookies
  if (!token && req.cookies) {
    token = req.cookies.superadmin_access_token || req.cookies.user_access_token || req.cookies.access_token;
    if (token) {
      const source = req.cookies.superadmin_access_token ? "superadmin" : "user";
      console.log(`🍪 ${source} cookie token found`);
    }
  }

  if (!token) {
    const cookiesPresent = req.cookies ? Object.keys(req.cookies).join(', ') : 'none';
    console.log(`❌ No token found in ${req.method} ${req.path} from: ${req.headers.origin || req.headers.host} | Cookies: [ ${cookiesPresent} ]`);
    return res.status(401).json({ message: "Not authenticated" });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, payload) => {
    if (err) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    
    // Check if company is suspended (Only if not super_admin)
    if (payload.role !== 'super_admin' && payload.companyId) {
      const { pool } = require("../db");
      try {
        const companyRes = await pool.query("SELECT status FROM companies WHERE id = $1", [payload.companyId]);
        if (companyRes.rows.length > 0 && companyRes.rows[0].status === 'suspended') {
          console.warn(`🛑 Blocked access for suspended company: ${payload.companyId} (User: ${payload.email})`);
          return res.status(403).json({ 
            message: "Account Suspended/Disabled", 
            error: "your_company_is_suspended",
            details: "Your account is suspended/disabled because of some unusual activities found in your account. Please contact our customer care to reactivate account. Customer care email: prozyncinnovations@gmail.com"
          });
        }
      } catch (e) {
        console.error("Error checking suspension status:", e.message);
      }
    }

    req.user = payload;
    next();
  });
}

module.exports = { authenticateToken };
