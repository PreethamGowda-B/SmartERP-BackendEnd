const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const { loadPlan } = require("../middleware/planMiddleware");

const ContextEngine = require("../ai/context/context.engine");
const SecurityShield = require("../ai/gateway/security.shield");
const ReActEngine = require("../ai/planner/ReAct.engine");
const pluginRegistry = require("../ai/plugins");
const MetricsService = require("../ai/telemetry/metrics.service");
const { pool } = require("../db");

const AIDataService = require("../services/aiDataService");

let redisClient = null;
try {
  ({ redisClient } = require("../utils/redis"));
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
    const startTime = Date.now();
    try {
      const {
        message,
        history = [],
        clientContext = {},
        currentPortal,
        currentModule,
        currentPagePath,
        modelScopes = [],    // NEW: Array of specialist scopes for multi-agent mode
        autoMode = true,     // NEW: Whether auto model selection is enabled
      } = req.body;

      if (!message) {
        return res.status(400).json({ error: "Message prompt is required." });
      }

      // 1. Resolve Plan Tier (Fail-closed to "free" if plan missing/null)
      const planTier = getPlanTier(req);

      // 2. Sanitize & Defend Input
      const cleanMessage = SecurityShield.sanitizeInput(message);

      // Fast-Path 1: Instant Conversational Greetings (< 10ms response, 0 LLM calls, 0 fake data)
      const GREETING_REGEX = /^(hi+|hello+|hey+|hallo|greetings|good\s*(morning|afternoon|evening|day)|who\s*are\s*you|what\s*can\s*you\s*do|help|howdy|sup)[\s!.?]*$/i;
      if (GREETING_REGEX.test(cleanMessage.trim())) {
        const userName = req.user?.name || "there";
        return res.json({
          text: `Hello ${userName}! 👋 I'm **SmartERP Intelligence**, your enterprise AI assistant. How can I assist you today with your jobs, attendance, payroll, inventory, or financial reports?`,
          widget: null,
          confidenceScore: 1.0,
          sources: ["SmartERP Intelligence"],
          suggestedFollowUps: [
            "How many jobs are completed?",
            "Check today's attendance summary",
            "Audit low stock inventory",
            "View pending leave requests"
          ],
          telemetry: { latencyMs: Date.now() - startTime }
        });
      }

      // Fast-Path 2: Direct Live ERP Data Resolvers (Ultra-Fast Response)
      const promptLower = cleanMessage.toLowerCase();

      // "completed jobs" / "how many jobs are completed"
      if (promptLower.includes("completed job") || promptLower.includes("jobs completed") || promptLower.includes("how many jobs are completed") || promptLower.includes("how much jobs are completed")) {
        const companyId = req.user?.companyId || req.user?.company_id;
        if (!companyId) {
          return res.status(401).json({ message: 'Unauthorized: Missing company context.' });
        }
        const ownerSummary = await AIDataService.getOwnerDashboardSummary({ companyId });
        const completedCount = ownerSummary.jobs?.completed || 0;
        const totalJobs = ownerSummary.jobs?.total || 0;

        return res.json({
          text: `In your company, **${completedCount}** out of **${totalJobs}** total jobs are currently completed.`,
          widget: {
            type: "KPI_SUMMARY",
            title: "Completed Jobs Metric",
            metrics: [
              { label: "Completed Jobs", value: completedCount },
              { label: "Total Jobs", value: totalJobs }
            ]
          },
          navigation: { path: "/owner/jobs", label: "View All Jobs" },
          confidenceScore: 1.0,
          sources: ["Jobs Module (Live PostgreSQL)"],
          suggestedFollowUps: ["View in-progress jobs", "Check today's revenue", "Audit low stock inventory"],
          telemetry: { latencyMs: Date.now() - startTime }
        });
      }

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
              error: `AI rate limit reached (${maxAllowed} requests/hour for ${planTier.toUpperCase()} plan). Upgrade to increase limits.`,
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

          await MetricsService.logAIInterception({
            userContext,
            prompt: cleanMessage,
            matchedKeyword,
            planTier,
          });

          return res.json({
            text: "This feature requires the Pro Plan. Upgrade to unlock AI business analysis, forecasting, company insights, and advanced automation.",
            widget: null,
            navigation: { path: "/owner/billing", label: "Upgrade to Pro Plan" },
            confidenceScore: 1.0,
            sources: ["Subscription Guard"],
            intercepted: true,
            matchedKeyword,
            suggestedFollowUps: ["View pricing plans", "What's included in Pro?"],
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

      // 6. Determine Model Scope (Auto-detection or manual)
      let resolvedScopes = [];
      let autoSelectedModel = null;

      if (modelScopes && modelScopes.length > 0) {
        // Manual selection — use provided scopes
        resolvedScopes = modelScopes;
      } else if (autoMode !== false) {
        // Auto-detection from prompt
        const detectedScope = ContextEngine.detectModelScope(cleanMessage);
        resolvedScopes = [detectedScope];
        autoSelectedModel = detectedScope;
      } else {
        resolvedScopes = ["general"];
      }

      // 7. Execute ReAct Engine per scope (sequential multi-agent)
      let finalResult;

      if (resolvedScopes.length <= 1) {
        // Single scope execution
        const scope = resolvedScopes[0] || "general";
        const systemPrompt = ContextEngine.generateSystemPrompt(context, scope);

        finalResult = await ReActEngine.run({
          userPrompt: cleanMessage,
          history,
          context,
          systemPromptOverride: systemPrompt,
        });

        finalResult.autoSelectedModel = autoSelectedModel;
        finalResult.activeModelScope = scope;
        finalResult.suggestedFollowUps = ContextEngine.getSuggestedFollowUps(scope);
      } else {
        // Multi-agent: run sequentially per scope, combine responses
        const scopeResults = [];
        for (const scope of resolvedScopes) {
          try {
            const systemPrompt = ContextEngine.generateSystemPrompt(context, scope);
            const scopeResult = await ReActEngine.run({
              userPrompt: cleanMessage,
              history,
              context,
              systemPromptOverride: systemPrompt,
            });
            scopeResults.push({ scope, result: scopeResult });
          } catch (scopeErr) {
            console.warn(`⚠️ Multi-agent scope '${scope}' failed:`, scopeErr.message);
            scopeResults.push({
              scope,
              result: { text: `${scope} AI encountered an issue.`, sources: [], confidenceScore: 0 },
            });
          }
        }

        // Combine multi-scope responses
        const combinedText = scopeResults
          .map(({ scope, result }) => {
            const label = scope.charAt(0).toUpperCase() + scope.slice(1);
            return `**${label} AI:**\n${result.text}`;
          })
          .join("\n\n---\n\n");

        const combinedSources = [...new Set(scopeResults.flatMap((r) => r.result.sources || []))];
        const avgConfidence =
          scopeResults.reduce((sum, r) => sum + (r.result.confidenceScore || 0), 0) /
          scopeResults.length;
        const widgets = scopeResults.filter((r) => r.result.widget).map((r) => r.result.widget);

        finalResult = {
          text: combinedText,
          widget: widgets.length > 0 ? widgets[0] : null,
          navigation: scopeResults.find((r) => r.result.navigation)?.result.navigation || null,
          confidenceScore: parseFloat(avgConfidence.toFixed(4)),
          sources: combinedSources,
          telemetry: scopeResults[0]?.result.telemetry || { latencyMs: Date.now() - startTime },
          autoSelectedModel: null,
          activeModelScope: resolvedScopes.join("+"),
          suggestedFollowUps: ContextEngine.getSuggestedFollowUps(resolvedScopes[0]),
          multiAgent: true,
          scopesUsed: resolvedScopes,
        };
      }

      // 8. Extended Audit Logging
      const latencyMs = Date.now() - startTime;
      await MetricsService.logAIAuditEvent({
        userContext: context,
        toolName: `AI_REQUEST:${finalResult.activeModelScope || "general"}`,
        params: { scope: finalResult.activeModelScope, multiAgent: resolvedScopes.length > 1 },
        status: "SUCCESS",
        portal: context.ui.portal,
        module: context.ui.module,
        planTier,
        modelScope: finalResult.activeModelScope,
        latencyMs,
        confidenceScore: finalResult.confidenceScore,
        blocked: false,
        promptPreview: cleanMessage,
      });

      // Persist to CNC Enterprise AI Action Audit Trail
      const companyId = req.user.companyId || req.user.company_id;
      const userId = req.user.userId || req.user.id || '00000000-0000-0000-0000-000000000000';
      const userName = req.user.name || 'Owner';
      if (companyId) {
        await pool.query(
          `INSERT INTO ai_action_audit_trail (company_id, user_id, user_name, prompt, ai_interpretation, workflow_type, execution_level, approval_status, result_summary, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, 'executed', $7, NOW())`,
          [String(companyId), String(userId), userName, cleanMessage, finalResult.text?.substring(0, 500) || 'Query Analyzed', finalResult.activeModelScope || 'general', finalResult.text?.substring(0, 500) || 'Completed']
        ).catch(() => {});
      }

      finalResult.telemetry = {
        ...(finalResult.telemetry || {}),
        latencyMs,
        planTier,
      };

      res.json(finalResult);
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

// ── GET /api/ai/stats ─────────────────────────────────────────────────────────
// AI Usage Statistics for Super Admin Operations Dashboard
router.get(
  "/stats",
  authenticateToken,
  async (req, res) => {
    try {
      if (req.user?.role !== "super_admin") {
        return res.status(403).json({ error: "Access denied. Super Admin only." });
      }

      const stats = await MetricsService.getAIStats();
      res.json(stats);
    } catch (error) {
      console.error("❌ AI Stats Error:", error);
      res.status(500).json({ error: "Failed to retrieve AI statistics." });
    }
  }
);

// ── GET /api/ai/audit-logs ───────────────────────────────────────────────────
// Paginated AI Audit Logs for Super Admin Operations Dashboard
router.get(
  "/audit-logs",
  authenticateToken,
  async (req, res) => {
    try {
      const isSuperAdmin = req.user?.role === "super_admin";
      const isOwner = req.user?.role === "owner";

      if (!isSuperAdmin && !isOwner) {
        return res.status(403).json({ error: "Access denied. Owner or Super Admin required." });
      }

      const { page = 1, limit = 50, companyId, status, fromDate } = req.query;

      // Owners are strictly restricted to their own company_id
      const effectiveCompanyId = isOwner ? req.user.company_id : (companyId || null);

      const result = await MetricsService.getAuditLogs({
        page: parseInt(page),
        limit: parseInt(limit),
        companyId: effectiveCompanyId,
        status: status || null,
        fromDate: fromDate || null,
      });

      res.json(result);
    } catch (error) {
      console.error("❌ AI Audit Logs Error:", error);
      res.status(500).json({ error: "Failed to retrieve audit logs." });
    }
  }
);

// ── Legacy route compatibility ────────────────────────────────────────────────
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
