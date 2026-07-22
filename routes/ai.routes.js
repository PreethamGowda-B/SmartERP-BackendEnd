const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const { loadPlan } = require("../middleware/planMiddleware");
const { requireFeature } = require("../middleware/featureGuard");

const ContextEngine = require("../ai/context/context.engine");
const SecurityShield = require("../ai/gateway/security.shield");
const ReActEngine = require("../ai/planner/ReAct.engine");
const pluginRegistry = require("../ai/plugins");

let redisClient = null;
try {
  redisClient = require("../utils/redis");
} catch {
  // Redis optional
}

// ── POST /api/ai/agent ────────────────────────────────────────────────────────
// Enterprise AI Agent Execution Endpoint
// Gated: Pro plan / ai_assistant feature
// Security: Multi-tenant RLS, Role Permission Guard, Security Shield, Rate Limiting
router.post(
  "/agent",
  authenticateToken,
  loadPlan,
  requireFeature("ai_assistant"),
  async (req, res) => {
    try {
      const { message, history = [], clientContext = {} } = req.body;

      if (!message) {
        return res.status(400).json({ error: "Message prompt is required." });
      }

      // 1. Sanitize & Defend Input
      const cleanMessage = SecurityShield.sanitizeInput(message);

      // 2. Per-user Rate Limiting (30 requests/hour)
      if (redisClient && redisClient.status === "ready") {
        const userId = req.user?.userId || req.user?.id;
        const rateLimitKey = `ai_agent:${userId}`;
        try {
          const count = await redisClient.incr(rateLimitKey);
          if (count === 1) {
            await redisClient.expire(rateLimitKey, 3600);
          }
          if (count > 30) {
            const ttl = await redisClient.ttl(rateLimitKey);
            return res.status(429).json({
              error: "AI Agent rate limit reached (30 requests/hour).",
              retryAfter: ttl,
            });
          }
        } catch (redisErr) {
          console.warn("⚠️ AI rate limit Redis error:", redisErr.message);
        }
      }

      // 3. Build Authenticated Context (Tenant Scoped)
      const context = ContextEngine.buildContext(req, clientContext);

      // 4. Run ReAct Agent Loop
      const result = await ReActEngine.run({
        userPrompt: cleanMessage,
        history,
        context,
      });

      res.json(result);
    } catch (error) {
      console.error("❌ SmartERP AI Agent Error:", error);
      res.status(500).json({
        error: error.message || "AI Agent is temporarily unavailable. Please try again.",
      });
    }
  }
);

// ── POST /api/ai/confirm-action ───────────────────────────────────────────────
// Executes confirmed state-changing / destructive actions
router.post(
  "/confirm-action",
  authenticateToken,
  loadPlan,
  requireFeature("ai_assistant"),
  async (req, res) => {
    try {
      const { toolName, params = {} } = req.body;

      if (!toolName) {
        return res.status(400).json({ error: "Tool name is required for action execution." });
      }

      const context = ContextEngine.buildContext(req);
      const confirmedParams = { ...params, confirmed: true };

      const result = await pluginRegistry.execute(toolName, confirmedParams, context);
      res.json(result);
    } catch (error) {
      console.error("❌ AI Action Confirmation Error:", error);
      res.status(500).json({ error: error.message || "Action execution failed." });
    }
  }
);

// Legacy route compatibility
router.post(
  "/chat",
  authenticateToken,
  loadPlan,
  requireFeature("ai_assistant"),
  async (req, res) => {
    try {
      const { message } = req.body;
      const context = ContextEngine.buildContext(req);
      const result = await ReActEngine.run({ userPrompt: message, context });
      res.json({ reply: result.text });
    } catch (error) {
      res.status(500).json({ error: "AI error" });
    }
  }
);

module.exports = router;
