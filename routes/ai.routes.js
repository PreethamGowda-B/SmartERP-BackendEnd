const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const { createAiPromptGuard } = require('../middleware/aiPromptGuard');
const { loadPlan } = require("../middleware/planMiddleware");
const { requireFeature } = require("../middleware/featureGuard");
const { resolvePlanTier } = require("../services/subscriptionCatalog");
const { consumeAIRequest } = require("../services/aiQuota");

const ContextEngine = require("../ai/context/context.engine");
const ReActEngine = require("../ai/planner/ReAct.engine");
const pluginRegistry = require("../ai/plugins");
const MetricsService = require("../ai/telemetry/metrics.service");
const { pool } = require("../db");

const AIDataService = require("../services/aiDataService");
const { loadAttendanceSummary } = require("../services/aiAttendanceSummary");
const { canUseAiFastPath } = require("../services/aiMetricAccess");
const validateAiPrompt = createAiPromptGuard();

let redisClient = null;
try {
  ({ redisClient } = require("../utils/redis"));
} catch {
  // Redis optional
}

async function enforceAIRequestQuota(req, res, next) {
  const quota = await consumeAIRequest(redisClient, req.user?.userId || req.user?.id, getPlanTier(req));
  if (!quota.allowed) return res.status(quota.status).json({
    code: quota.status === 429 ? 'PLAN_LIMIT_REACHED' : 'PLAN_LIMIT_CHECK_UNAVAILABLE',
    error: quota.error,
    message: quota.error,
    retryAfter: quota.retryAfter,
    planTier: getPlanTier(req),
    ...(quota.status === 429 ? { details: { limitType: 'ai_messages', currentCount: quota.count, maxLimit: quota.limit, currentPlan: req.plan?.name || 'Starter' } } : {})
  });
  next();
}

/**
 * Resolves the backend-authoritative plan row to its stable subscription tier.
 * @param {Object} req - Express Request
 * @returns {"starter" | "professional" | "enterprise"} Stable plan tier
 */
function getPlanTier(req) {
  return resolvePlanTier(req.plan);
}

// Enterprise-only AI topics remain a secondary guard; requireFeature below is
// the authoritative direct-API entitlement check.
const ENTERPRISE_CAPABILITY_KEYWORDS = [
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
function checkEnterpriseCapabilityKeyword(prompt) {
  if (!prompt || typeof prompt !== "string") return null;
  const lower = prompt.toLowerCase();
  for (const keyword of ENTERPRISE_CAPABILITY_KEYWORDS) {
    if (lower.includes(keyword)) {
      return keyword;
    }
  }
  return null;
}

// ── POST /api/ai/agent ────────────────────────────────────────────────────────
// Enterprise Subscription-Aware, Permission-Aware, Context-Aware AI Agent Endpoint
router.post(
  "/agent",
  authenticateToken,
  loadPlan,
  requireFeature('ai_assistant', 'AI assistant'),
  validateAiPrompt,
  enforceAIRequestQuota,
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

      // 1. Resolve stable plan tier from the loaded company plan row.
      const planTier = getPlanTier(req);

      // 2. Sanitize & Defend Input
      const cleanMessage = req.sanitizedAiMessage;

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

      // Fast-Path 2: Direct Live ERP Data Resolvers (Ultra-Fast Response < 25ms, Zero LLM Errors)
      const promptLower = cleanMessage.toLowerCase();
      const companyId = req.user?.companyId || req.user?.company_id;
      const role = req.user?.role;

      // ── Attendance Summary Resolver ──────────────────────────────────────────
      if (
        promptLower.includes("attendance") ||
        promptLower.includes("who is present") ||
        promptLower.includes("present today") ||
        promptLower.includes("absent today") ||
        promptLower.includes("today's attendance") ||
        promptLower.includes("clocked in") ||
        promptLower.includes("late arrival") ||
        promptLower.includes("who is late")
      ) {
        let attendanceAccess;
        try {
          attendanceAccess = await loadAttendanceSummary({
            role: req.user?.role,
            companyId,
            dataService: AIDataService,
          });
        } catch (error) {
          console.error("AI attendance summary unavailable:", error.message);
          return res.status(503).json({ error: "Attendance summary is temporarily unavailable. Please try again." });
        }

        if (!attendanceAccess) {
          return res.status(403).json({ message: 'Attendance summary is not available for this account.' });
        }

        const companyAttendance = attendanceAccess.summary;
        const presentCount = companyAttendance.present;
        const absentCount = companyAttendance.absent;
        const onLeaveCount = companyAttendance.on_leave;
        const lateCount = companyAttendance.late;
        const totalEmployees = companyAttendance.total;

        const lateDetail = lateCount > 0 ? ` (${lateCount} late)` : '';

        return res.json({
          text: `Today's Attendance Summary: **${presentCount}** employee(s) present${lateDetail}, **${absentCount}** absent, and **${onLeaveCount}** on approved leave (out of **${totalEmployees}** total active staff).`,
          widget: {
            type: "KPI_SUMMARY",
            title: "Today's Attendance Overview",
            metrics: [
              { label: "Present", value: presentCount },
              { label: "Absent", value: absentCount },
              { label: "Late Arrivals", value: lateCount },
              { label: "Total Staff", value: totalEmployees }
            ]
          },
          navigation: {
            path: req.user?.role === "hr"
              ? "/hr/attendance"
              : req.user?.role === "employee" ? "/employee/time" : "/owner/attendance",
            label: "View Attendance Records",
          },
          confidenceScore: 1.0,
          sources: ["Attendance System (Live PostgreSQL)"],
          autoSelectedModel: "Attendance AI",
          suggestedFollowUps: ["Payroll summary", "Pending leave requests", "View completed jobs"],
          telemetry: { latencyMs: Date.now() - startTime }
        });
      }

      // ── Completed Jobs Resolver ──────────────────────────────────────────────
      if (canUseAiFastPath("jobs", role) && (promptLower.includes("completed job") || promptLower.includes("jobs completed") || promptLower.includes("how many jobs are completed") || promptLower.includes("how much jobs are completed"))) {
        if (!companyId) {
          return res.status(403).json({ message: 'Company access context is unavailable for this account.' });
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
          autoSelectedModel: "General Assistant",
          suggestedFollowUps: ["View in-progress jobs", "Check today's attendance", "Audit low stock inventory"],
          telemetry: { latencyMs: Date.now() - startTime }
        });
      }

      // ── Payroll / Salary Resolver ───────────────────────────────────────────
      if (
        canUseAiFastPath("payroll", role) && (
        promptLower.includes("payroll") ||
        promptLower.includes("salary") ||
        promptLower.includes("payout")
        )
      ) {
        if (!companyId) {
          return res.status(403).json({ message: 'Company access context is unavailable for this account.' });
        }
        const isOwnerOrAdmin = role === "owner" || role === "admin";
        const payrollSummary = isOwnerOrAdmin
          ? await AIDataService.getOwnerDashboardSummary({ companyId })
          : await AIDataService.getHrDashboardSummary({ companyId });
        const activeStaff = isOwnerOrAdmin
          ? payrollSummary.employees?.active_count || 0
          : (payrollSummary.department_headcount || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
        const pendingLeaves = isOwnerOrAdmin
          ? payrollSummary.leaves?.pending_requests || 0
          : (payrollSummary.pending_leave_requests || []).length;

        return res.json({
          text: `Payroll Status Overview: Managing **${activeStaff}** active staff members. Currently **${pendingLeaves}** pending leave requests require authorization before final cycle disbursement.`,
          widget: {
            type: "KPI_SUMMARY",
            title: "Payroll & Staff Health",
            metrics: [
              { label: "Active Staff", value: activeStaff },
              { label: "Pending Leaves", value: pendingLeaves }
            ]
          },
          navigation: { path: "/owner/payroll", label: "Open Payroll Console" },
          confidenceScore: 1.0,
          sources: ["Payroll & HR Module (Live PostgreSQL)"],
          autoSelectedModel: "Payroll AI",
          suggestedFollowUps: ["Check today's attendance", "View pending leaves", "Financial summary"],
          telemetry: { latencyMs: Date.now() - startTime }
        });
      }

      // ── Inventory / Stock Resolver ──────────────────────────────────────────
      if (
        canUseAiFastPath("inventory", role) && (
        promptLower.includes("inventory") ||
        promptLower.includes("stock") ||
        promptLower.includes("low stock") ||
        promptLower.includes("materials")
        )
      ) {
        if (!companyId) {
          return res.status(403).json({ message: 'Company access context is unavailable for this account.' });
        }
        const ownerSummary = await AIDataService.getOwnerDashboardSummary({ companyId });
        const lowStockCount = ownerSummary.inventory?.low_stock_count || 0;

        return res.json({
          text: lowStockCount > 0
            ? `⚠️ Low Stock Warning: **${lowStockCount}** inventory item(s) have reached or fallen below their minimum threshold.`
            : `Inventory Status: All warehouse and inventory stock levels are currently within optimal thresholds.`,
          widget: {
            type: "KPI_SUMMARY",
            title: "Inventory Health",
            metrics: [
              { label: "Low Stock Items", value: lowStockCount }
            ]
          },
          navigation: { path: "/owner/inventory", label: "Manage Inventory" },
          confidenceScore: 1.0,
          sources: ["Inventory Module (Live PostgreSQL)"],
          autoSelectedModel: "Inventory AI",
          suggestedFollowUps: ["Completed jobs", "Today's attendance", "Financial summary"],
          telemetry: { latencyMs: Date.now() - startTime }
        });
      }

      // ── GST & Financials Resolver ───────────────────────────────────────────
      if (
        canUseAiFastPath("financial", role) && (
        promptLower.includes("gst") ||
        promptLower.includes("financial") ||
        promptLower.includes("revenue") ||
        promptLower.includes("invoice")
        )
      ) {
        if (!companyId) {
          return res.status(403).json({ message: 'Company access context is unavailable for this account.' });
        }
        const ownerSummary = await AIDataService.getOwnerDashboardSummary({ companyId });
        const todayRev = ownerSummary.revenue?.today || 0;
        const monthRev = ownerSummary.revenue?.this_month || 0;
        const pendingInvoices = ownerSummary.invoices?.pending_count || 0;

        return res.json({
          text: `Financial & GST Snapshot: Today's realized revenue is **₹${todayRev.toLocaleString('en-IN')}** (Month-to-Date: **₹${monthRev.toLocaleString('en-IN')}**). There are **${pendingInvoices}** open/pending invoice records.`,
          widget: {
            type: "KPI_SUMMARY",
            title: "Financial Ledger Snapshot",
            metrics: [
              { label: "Today's Revenue", value: `₹${todayRev}` },
              { label: "Month-to-Date", value: `₹${monthRev}` },
              { label: "Invoices", value: pendingInvoices }
            ]
          },
          navigation: { path: "/owner/finance", label: "Open Financial Hub" },
          confidenceScore: 1.0,
          sources: ["Finance & GST Module (Live PostgreSQL)"],
          autoSelectedModel: "Finance AI",
          suggestedFollowUps: ["Today's attendance", "Payroll summary", "Inventory status"],
          telemetry: { latencyMs: Date.now() - startTime }
        });
      }

      // ── Contact Support / Help Resolver ──────────────────────────────────────
      if (
        promptLower.includes("contact support") ||
        promptLower.includes("support") ||
        promptLower.includes("customer care") ||
        promptLower.includes("help desk")
      ) {
        return res.json({
          text: `If you need assistance, you can reach SmartERP Support through any of the following channels:\n\n• **Email:** support@smarterp.com\n• **Phone (India):** +91-80-1234-5678 (9 AM - 6 PM IST)\n• **Support Portal:** Submit a support ticket and track its resolution in real time.`,
          widget: null,
          navigation: { path: "/support", label: "Open Support Portal" },
          confidenceScore: 1.0,
          sources: ["SmartERP Support Gateway"],
          autoSelectedModel: "General Assistant",
          suggestedFollowUps: ["Check today's attendance", "Payroll summary", "View completed jobs"],
          telemetry: { latencyMs: Date.now() - startTime }
        });
      }

      // 4. Secondary topic filter for Enterprise-only capabilities.
      if (planTier !== "enterprise") {
        const matchedKeyword = checkEnterpriseCapabilityKeyword(cleanMessage);
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
            text: "This AI capability is not included in your current plan. Review available plans with your company owner.",
            widget: null,
            navigation: { path: "/owner/billing", label: "Review available plans" },
            confidenceScore: 1.0,
            sources: ["Subscription Guard"],
            intercepted: true,
            matchedKeyword,
            suggestedFollowUps: ["View pricing plans", "What features are available?"],
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
      const auditUserId = req.user?.userId || req.user?.id || '00000000-0000-0000-0000-000000000000';
      const userName = req.user?.name || 'Owner';
      if (companyId) {
        await pool.query(
          `INSERT INTO ai_action_audit_trail (company_id, user_id, user_name, prompt, ai_interpretation, workflow_type, execution_level, approval_status, result_summary, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, 'executed', $7, NOW())`,
          [String(companyId), String(auditUserId), userName, cleanMessage, finalResult.text?.substring(0, 500) || 'Query Analyzed', finalResult.activeModelScope || 'general', finalResult.text?.substring(0, 500) || 'Completed']
        ).catch(() => {});
      }

      finalResult.telemetry = {
        ...(finalResult.telemetry || {}),
        latencyMs,
        planTier,
      };

      res.json(finalResult);
    } catch (error) {
      if (error?.statusCode === 503 && typeof error?.code === 'string' && error.code.startsWith('AI_PROVIDER_')) {
        console.error("❌ SmartERP AI provider unavailable:", {
          code: error.code,
          providerErrorCode: error.providerErrorCode || null,
        });
        return res.status(503).json({
          code: error.code,
          error: error.code === 'AI_PROVIDER_NOT_CONFIGURED'
            ? 'SmartERP AI is not configured on the server. Please contact your administrator.'
            : 'SmartERP AI provider is temporarily unavailable. Please retry shortly.',
        });
      }
      console.error("❌ SmartERP AI Agent Error:", error?.code || error?.name || 'unknown_error');
      res.status(500).json({
        code: 'AI_AGENT_FAILED',
        error: "SmartERP AI could not complete this request. Please retry shortly.",
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
  requireFeature('ai_assistant', 'AI assistant'),
  enforceAIRequestQuota,
  async (req, res) => {
    try {
      const { toolName, params = {} } = req.body;

      if (!toolName) {
        return res.status(400).json({ error: "Tool name is required for action execution." });
      }

      if (params && typeof params === 'object') {
        const SecurityShield = require('../ai/gateway/security.shield');
        for (const [key, val] of Object.entries(params)) {
          if (typeof val === 'string') {
            const check = SecurityShield.inspectPrompt(val);
            if (check.blocked && check.isAttack) {
              const { emitSecurityEvent, SECURITY_EVENT_TYPES } = require("../utils/securityEmitter");
              emitSecurityEvent({
                companyId: req.user?.companyId || req.user?.company_id,
                userId: req.user?.userId || req.user?.id,
                eventType: SECURITY_EVENT_TYPES.PROMPT_INJECTION,
                severity: check.riskLevel || 'high',
                ipAddress: req.ip || req.headers?.['x-forwarded-for'],
                userAgent: req.headers?.['user-agent'],
                endpoint: '/api/ai/confirm-action',
                httpMethod: 'POST',
                statusCode: 400,
                metadata: {
                  reason: check.reason,
                  paramKey: key,
                },
              });
              return res.status(400).json({
                error: "SECURITY_VIOLATION",
                message: `Security violation in parameter '${key}': ${check.reason}`,
                code: "INJECTION_IN_ACTION_PARAM"
              });
            }
          }
        }
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
  requireFeature('ai_assistant', 'AI assistant'),
  validateAiPrompt,
  enforceAIRequestQuota,
  async (req, res) => {
    try {
      const message = req.sanitizedAiMessage;
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
