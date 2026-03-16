const jwt = require("jsonwebtoken");

// ─── Redis client for suspension caching ────────────────────────────────────
// Graceful: if Redis is unavailable, falls through to DB check transparently.
let redisClient = null;
try {
  if (process.env.REDIS_URL) {
    const Redis = require("ioredis");
    // ioredis handles connections automatically and queues commands
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 3) return null; // stop retrying after 3 attempts
        return Math.min(times * 200, 1000);
      }
    });
    
    redisClient.on("error", (err) => {
      console.warn("⚠️ Redis cache error:", err.message);
    });
  }
} catch (e) {
  console.warn("⚠️ Redis/ioredis setup failed, suspension cache disabled:", e.message);
  redisClient = null;
}

const SUSPENSION_CACHE_TTL = 60; // seconds

async function isCompanySuspended(companyId) {
  const cacheKey = `company_suspended:${companyId}`;

  // 1. Try Redis cache first (reduces DB load significantly)
  if (redisClient && redisClient.status === 'ready') {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached !== null) {
        return cached === "1";
      }
    } catch (e) {
      // Redis error — fall through to DB
    }
  }

  // 2. DB fallback
  const { pool } = require("../db");
  const companyRes = await pool.query("SELECT status FROM companies WHERE id = $1", [companyId]);
  const suspended = companyRes.rows.length > 0 && companyRes.rows[0].status === "suspended";

  // 3. Store result in Redis for subsequent requests
  if (redisClient && redisClient.status === 'ready') {
    try {
      await redisClient.set(cacheKey, suspended ? "1" : "0", { EX: SUSPENSION_CACHE_TTL });
    } catch (e) {
      // Ignore Redis write errors
    }
  }

  return suspended;
}

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
    
    // Check if company is suspended (Only if not super_admin) — Redis-cached with 60s TTL
    if (payload.role !== 'super_admin' && payload.companyId) {
      try {
        const suspended = await isCompanySuspended(payload.companyId);
        if (suspended) {
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
