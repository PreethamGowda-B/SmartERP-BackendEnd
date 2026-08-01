const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const { loadPlan } = require("../middleware/planMiddleware");

const ContextEngine = require("../ai/context/context.engine");
const SecurityShield = require("../ai/gateway/security.shield");
const ReActEngine = require("../ai/planner/ReAct.engine");
const pluginRegistry = require("../ai/plugins");
const MetricsService = require("../ai/telemetry/metrics.service");

let redisClient = null;
try {
  redisClient = require("../utils/redis");
} catch {
  // Redis optional
}

/**
 * Resolves requesting user's plan tier with strict fail-closed fallback to "free".
 * @param {Object} req - Express Request
 * @returns {"free" | "basic" | "pro"} Lowercase plan tier
 */
function getPlanTier(req) {
  if (!req.plan || !req.plan.id) {
    return "free";
  }
  const planId = String(req.plan.id).toLowerCase();
  const planName = String(req.plan.name || "").toLowerCase();

  if (planId.includes("pro") || planName.includes("pro")) return "pro";
  if (planId.includes("basic") || planName.includes("basic")) return "basic";
  return "free";
}

// Pro-only capability keyword/phrase list for rule-based classification
const PRO_CAPABILITY_KEYWORDS = [
  "forecast",
  "forecasting",
  "executive report",
  "analyze company",
  "cross-module",
  "financial analytics",
  "revenue forecast",
  "cash flow",
  "gst reconciliation",
  "ar collection",
  "payroll validation",
  "company insights",
  "business analysis",
  "predictive",
];

/**
 * Rule-based classifier checking if a prompt requests a Pro-only capability.
 * @param {string} prompt - User message prompt
 * @returns {string|null} Matched keyword or null
 */
function checkProCapabilityKeyword(prompt) {
  if (!prompt || typeof prompt !== "string") return null;
  const lower = prompt.toLowerCase();
  for (const keyword of PRO_CAPABILITY_KEYWORDS) {
    if (lower.includes(keyword)) {
      return keyword;
    }
  }
  return null;
}

// Rate limit caps per plan tier (requests per hour)
const TIER_RATE_LIMITS = {
  free: 5,
  basic: 15,
  pro: 30,
};

// ── POST /api/ai/agent ────────────────────────────────────────────────────────
// Enterprise Subscription-Aware, Permission-Aware, Context-Aware AI Agent Endpoint
router.post(
  "/agent",
  authenticateToken,
  loadPlan,
  async (req, res) => {
    try {
      const { message, history = [], clientContext = {}, currentPortal, currentModule, currentPagePath } = req.body;

      if (!message) {
        return res.status(400).json({ error: "Message prompt is required." });
      }

      // 1. Resolve Plan Tier (Fail-closed to "free" if plan missing/null)
      const planTier = getPlanTier(req);

      // 2. Sanitize & Defend Input
      const cleanMessage = SecurityShield.sanitizeInput(message);

      // 3. Plan-Tier Scaled Rate Limiting (Free: 5/hr, Basic: 15/hr, Pro: 30/hr)
      if (redisClient && redisClient.status === "ready") {
        const userId = req.user?.userId || req.user?.id;
        const rateLimitKey = `ai_agent:${userId}`;
        const maxAllowed = TIER_RATE_LIMITS[planTier] || 5;

        try {
          const count = await redisClient.incr(rateLimitKey);
          if (count === 1) {
            await redisClient.expire(rateLimitKey, 3600);
          }
          if (count > maxAllowed) {
            const ttl = await redisClient.ttl(rateLimitKey);
            return res.status(429).json({
              error: `AI Agent rate limit reached (${maxAllowed} requests/hour for ${planTier.toUpperCase()} plan). Upgrade to increase limits.`,
              retryAfter: ttl,
              planTier,
            });
          }
        } catch (redisErr) {
          console.warn("⚠️ AI rate limit Redis error:", redisErr.message);
        }
      }

      // 4. Rule-Based Interception for Pro-Only Capabilities on Free/Basic Plans
      if (planTier === "free" || planTier === "basic") {
        const matchedKeyword = checkProCapabilityKeyword(cleanMessage);
        if (matchedKeyword) {
          const userContext = ContextEngine.buildContext(
            req,
            { ...clientContext, currentPortal, currentModule, currentPagePath },
            planTier
          );

          // Log Interception for false positive/negative evaluation & audit
          await MetricsService.logAIInterception({
            userContext,
            prompt: cleanMessage,
            matchedKeyword,
            planTier,
          });

          // Return canned response immediately BEFORE calling Groq
          return res.json({
            text: "This feature requires the Pro Plan. Upgrade to unlock AI business analysis, forecasting, company insights, and advanced automation.",
            widget: null,
            navigation: { path: "/owner/billing", label: "Upgrade to Pro Plan" },
            confidenceScore: 1.0,
            sources: ["Subscription Guard"],
            intercepted: true,
            matchedKeyword,
          });
        }
      }

      // 5. Build Authenticated Context (Tenant Scoped + Plan Tier + Advisory UI Route Context)
      const mergedClientContext = {
        ...clientContext,
        currentPortal: currentPortal || clientContext.currentPortal || clientContext.portal,
        currentModule: currentModule || clientContext.currentModule || clientContext.module,
        currentPagePath: currentPagePath || clientContext.currentPagePath || clientContext.pagePath || clientContext.currentPage,
      };

      const context = ContextEngine.buildContext(req, mergedClientContext, planTier);

      // 6. Run ReAct Agent Loop
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
// Executes confirmed state-changing / destructive actions with RBAC & Plan Guards
router.post(
  "/confirm-action",
  authenticateToken,
  loadPlan,
  async (req, res) => {
    try {
      const { toolName, params = {} } = req.body;

      if (!toolName) {
        return res.status(400).json({ error: "Tool name is required for action execution." });
      }

      const planTier = getPlanTier(req);
      const context = ContextEngine.buildContext(req, {}, planTier);
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
  async (req, res) => {
    try {
      const { message } = req.body;
      const planTier = getPlanTier(req);
      const context = ContextEngine.buildContext(req, {}, planTier);
      const result = await ReActEngine.run({ userPrompt: message, context });
      res.json({ reply: result.text });
    } catch (error) {
      res.status(500).json({ error: "AI error" });
    }
  }
);

module.exports = router;
