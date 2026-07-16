const express = require("express");
const router = express.Router();

const { chatWithAI } = require("../services/ai.service");
const { authenticateToken } = require("../middleware/authMiddleware");
const { loadPlan } = require("../middleware/planMiddleware");
const { requireFeature } = require("../middleware/featureGuard");

let redisClient = null;
try {
  redisClient = require("../utils/redis");
} catch {
  // Redis optional — rate limiting degrades gracefully
}

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
// Gated: Pro plan only (ai_assistant feature)
// Security: message length validated, per-user rate limited (20 req/hour)
router.post(
  "/chat",
  authenticateToken,
  loadPlan,
  requireFeature("ai_assistant"),
  async (req, res) => {
    try {
      const { message } = req.body;

      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }

      // Server-side message length guard — prevents API abuse / excessive billing
      if (typeof message !== "string" || message.trim().length === 0) {
        return res.status(400).json({ error: "Message must be a non-empty string" });
      }
      if (message.length > 1000) {
        return res.status(400).json({ error: "Message must be under 1000 characters" });
      }

      // Per-user hourly rate limit (20 requests/hour)
      if (redisClient && redisClient.status === "ready") {
        const userId = req.user?.userId || req.user?.id;
        const rateLimitKey = `ai_chat:${userId}`;
        try {
          const count = await redisClient.incr(rateLimitKey);
          if (count === 1) {
            await redisClient.expire(rateLimitKey, 3600); // 1 hour window
          }
          if (count > 20) {
            const ttl = await redisClient.ttl(rateLimitKey);
            return res.status(429).json({
              error: "AI rate limit reached. You can send 20 messages per hour.",
              retryAfter: ttl,
            });
          }
        } catch (redisErr) {
          console.warn("⚠️ AI rate limit Redis error:", redisErr.message);
          // Fail open — don't block the request if Redis is down
        }
      }

      const reply = await chatWithAI(message.trim());
      res.json({ reply });
    } catch (error) {
      console.error("AI error:", error);
      res.status(500).json({ error: "AI Assistant is temporarily unavailable. Please try again in a few moments." });
    }
  }
);

module.exports = router;
