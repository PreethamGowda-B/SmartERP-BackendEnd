const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const { createAiPromptGuard } = require('../middleware/aiPromptGuard');
const { loadPlan } = require("../middleware/planMiddleware");
const { requireFeature } = require("../middleware/featureGuard");
const { resolvePlanTier } = require("../services/subscriptionCatalog");
const { resolveAiModelScopes } = require('../services/aiModelEntitlements');
const { getAiErrorResponse } = require('../utils/aiErrorResponse');
const { SAFE_PROMPT_REFUSAL } = require('../middleware/aiPromptGuard');

const ContextEngine = require("../ai/context/context.engine");
const ReActEngine = require("../ai/planner/ReAct.engine");
const pluginRegistry = require("../ai/plugins");
const MetricsService = require("../ai/telemetry/metrics.service");
const { pool } = require("../db");

const AIDataService = require("../services/aiDataService");
const { loadAttendanceSummary } = require("../services/aiAttendanceSummary");
const { canUseAiFastPath } = require("../services/aiMetricAccess");
const { isEmployeeAssignedJobsPrompt, createEmployeeAssignedJobsResponse } = require('../services/employeeAssignedJobsResponse');
const SecurityShield = require('../ai/gateway/security.shield');
const validateAiPrompt = createAiPromptGuard({
  historyField: 'history',
  contextField: 'clientContext',
  rootContextFields: ['currentPortal', 'currentModule', 'currentPagePath'],
});

function findBlockedActionInput(value, path = 'params', depth = 0) {
  if (depth > 12) return { invalid: true, path };
  if (typeof value === 'string') {
    const result = SecurityShield.inspectPrompt(value);
    return result.blocked && result.isAttack ? { path, result, length: value.length } : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findBlockedActionInput(value[i], `${path}[${i}]`, depth + 1);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const found = findBlockedActionInput(child, `${path}.${key}`, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolves the backend-authoritative plan row to its stable subscription tier.
 * @param {Object} req - Express Request
 * @returns {"starter" | "professional" | "enterprise"} Stable plan tier
 */
function getPlanTier(req) {
  return resolvePlanTier(req.plan);
}

// ── POST /api/ai/agent ────────────────────────────────────────────────────────
// Enterprise Subscription-Aware, Permission-Aware, Context-Aware AI Agent Endpoint
router.post(
  "/agent",
  authenticateToken,
  loadPlan,
  requireFeature('ai_assistant', 'AI assistant'),
  validateAiPrompt,
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

      // Deterministic employee lookup: this avoids asking the model to invent a
      // tool name for personal assignment questions and never loads company-wide
      // jobs for an employee.
      if (isEmployeeAssignedJobsPrompt(role, promptLower)) {
        const userId = req.user?.userId || req.user?.id;
        if (!companyId || !userId) {
          return res.status(403).json({ message: 'Employee and company access context is unavailable for this account.' });
        }
        const assignedJobs = await AIDataService.getEmployeeAssignedJobs({ userId, companyId, limit: 10 });
        return res.json(createEmployeeAssignedJobsResponse(assignedJobs, Date.now() - startTime));
      }

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
        const jobCounts = await AIDataService.getCompanyJobStatusCounts({ companyId });
        const completedCount = jobCounts.completed || 0;
        const totalJobs = Object.values(jobCounts).reduce((sum, count) => sum + count, 0);

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

      // ── Active Jobs Resolver ────────────────────────────────────────────────
      if (
        canUseAiFastPath("jobs", role) &&
        (promptLower.includes("active job") || promptLower.includes("in-progress job") || promptLower.includes("in progress job"))
      ) {
        if (!companyId) {
          return res.status(403).json({ message: 'Company access context is unavailable for this account.' });
        }
        const activeCount = role === "employee"
          ? await AIDataService.getEmployeeActiveJobCount({ userId: req.user?.userId || req.user?.id, companyId })
          : await (async () => {
              const counts = await AIDataService.getCompanyJobStatusCounts({ companyId });
              return Object.entries(counts).reduce(
                (sum, [status, count]) => sum + (["completed", "closed", "cancelled"].includes(status) ? 0 : count),
                0
              );
            })();

        return res.json({
          text: `There ${activeCount === 1 ? 'is' : 'are'} **${activeCount}** active job(s)${role === "employee" ? ' assigned to you' : ' in your company'}.`,
          widget: { type: "KPI_SUMMARY", title: "Active Jobs", metrics: [{ label: "Active Jobs", value: activeCount }] },
          navigation: { path: role === "employee" ? "/employee/tasks" : "/owner/jobs", label: "View Active Jobs" },
          confidenceScore: 1.0,
          sources: ["Jobs Module (Live PostgreSQL)"],
          autoSelectedModel: "Jobs AI",
          telemetry: { latencyMs: Date.now() - startTime },
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
        const lowStockCount = await AIDataService.getCompanyLowStockCount({ companyId });

        return res.json({
          text: lowStockCount > 0
            ? `⚠️ Low Stock Warning: **${lowStockCount}** inventory item(s) are below their configured reorder threshold.`
            : `No inventory items are currently below their configured reorder threshold.`,
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
        const financialSummary = await AIDataService.getCompanyInvoiceSummary({ companyId });
        const todayRev = financialSummary.todayRevenue;
        const monthRev = financialSummary.monthRevenue;
        const pendingInvoices = financialSummary.pending;

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

      // ── Pending Leave Resolver ──────────────────────────────────────────────
      if (
        promptLower.includes("pending leave") ||
        promptLower.includes("leave requests pending") ||
        promptLower.includes("leave request waiting")
      ) {
        const normalizedRole = String(role || "").toLowerCase();
        if (["owner", "admin", "hr", "employee"].includes(normalizedRole)) {
          if (!companyId) {
            return res.status(403).json({ message: 'Company access context is unavailable for this account.' });
          }
          const personal = normalizedRole === "employee";
          const pendingCount = await AIDataService.getPendingLeaveCount({
            companyId,
            userId: req.user?.userId || req.user?.id,
            personal,
          });
          return res.json({
            text: personal
              ? `You have **${pendingCount}** leave request(s) awaiting review.`
              : `There ${pendingCount === 1 ? 'is' : 'are'} **${pendingCount}** leave request(s) awaiting review in your company.`,
            widget: { type: "KPI_SUMMARY", title: "Pending Leave Requests", metrics: [{ label: "Awaiting Review", value: pendingCount }] },
            navigation: { path: normalizedRole === "hr" ? "/hr/requests" : normalizedRole === "employee" ? "/employee/time" : "/owner/attendance", label: "View Leave Requests" },
            confidenceScore: 1.0,
            sources: ["Leave Management (Live PostgreSQL)"],
            autoSelectedModel: "HR Assistant",
            telemetry: { latencyMs: Date.now() - startTime },
          });
        }
      }

      // ── Contact Support / Help Resolver ──────────────────────────────────────
      if (
        promptLower.includes("contact support") ||
        promptLower.includes("support") ||
        promptLower.includes("customer care") ||
        promptLower.includes("help desk")
      ) {
        return res.json({
          text: 'Please use the Support option in your SmartERP portal or contact your company administrator for help.',
          widget: null,
          navigation: null,
          confidenceScore: 1.0,
          sources: ["SmartERP Support Gateway"],
          autoSelectedModel: "General Assistant",
          suggestedFollowUps: ["Check today's attendance", "Payroll summary", "View completed jobs"],
          telemetry: { latencyMs: Date.now() - startTime }
        });
      }

      // 5. Build Authenticated Context (Tenant Scoped + Plan Tier + Advisory UI Route Context)
      const mergedClientContext = {
        ...clientContext,
        currentPortal: currentPortal || clientContext.currentPortal || clientContext.portal,
        currentModule: currentModule || clientContext.currentModule || clientContext.module,
        currentPagePath: currentPagePath || clientContext.currentPagePath || clientContext.pagePath || clientContext.currentPage,
      };

      const context = ContextEngine.buildContext(req, mergedClientContext, planTier);

      // 6. Resolve the model scopes included in this company's plan. AI messages
      // are not capped by count; plans control specialist model access only.
      const modelSelection = resolveAiModelScopes({
        planTier,
        requestedScopes: modelScopes,
        autoMode,
        prompt: cleanMessage,
        detectModelScope: (prompt) => ContextEngine.detectModelScope(prompt),
      });
      if (!modelSelection.ok) {
        return res.status(modelSelection.status).json({
          code: modelSelection.code,
          message: modelSelection.code === 'AI_MODEL_NOT_INCLUDED'
            ? 'One or more selected AI models are not included in your company plan.'
            : 'The AI model selection is invalid or the subscription plan could not be verified.',
          unavailableScopes: modelSelection.unavailableScopes,
        });
      }
      const resolvedScopes = modelSelection.scopes;
      const autoSelectedModel = modelSelection.autoSelectedModel;

      // 7. Execute independent selected scopes concurrently. The provider limiter
      // still caps global Groq concurrency, while parallel scope execution avoids
      // adding each agent's latency one after another.
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
          modelScope: scope,
        });

        finalResult.autoSelectedModel = autoSelectedModel;
        finalResult.activeModelScope = scope;
        finalResult.suggestedFollowUps = ContextEngine.getSuggestedFollowUps(scope);
      } else {
        // Multi-agent: run the selected scopes concurrently, then combine responses.
        const scopeResults = await Promise.all(resolvedScopes.map(async (scope) => {
          try {
            const systemPrompt = ContextEngine.generateSystemPrompt(context, scope);
            const result = await ReActEngine.run({
              userPrompt: cleanMessage,
              history,
              context,
              systemPromptOverride: systemPrompt,
              modelScope: scope,
            });
            return { scope, result };
          } catch (scopeErr) {
            console.warn(`⚠️ Multi-agent scope '${scope}' failed:`, scopeErr?.code || scopeErr?.name || 'provider_error');
            return {
              scope,
              failed: true,
              errorCode: scopeErr?.code || 'AI_SCOPE_UNAVAILABLE',
              result: { text: `${scope} AI is temporarily unavailable. No result was returned for this specialist.`, sources: [], confidenceScore: 0 },
            };
          }
        }));

        if (scopeResults.every((entry) => entry.failed)) {
          const error = new Error('All selected AI specialists failed to complete the request.');
          error.code = scopeResults.some((entry) => String(entry.errorCode).startsWith('AI_PROVIDER_'))
            ? 'AI_PROVIDER_UNAVAILABLE'
            : 'AI_TOOL_EXECUTION_FAILED';
          throw error;
        }

        // Combine multi-scope responses
        const combinedText = scopeResults
          .map(({ scope, result }) => {
            const label = scope.charAt(0).toUpperCase() + scope.slice(1);
            return `**${label} AI:**\n${result.text}`;
          })
          .join("\n\n---\n\n");

        const combinedSources = [...new Set(scopeResults.flatMap((r) => r.result.sources || []))];
        const widgets = scopeResults.filter((r) => r.result.widget).map((r) => r.result.widget);

        finalResult = {
          text: combinedText,
          widget: widgets.length > 0 ? widgets[0] : null,
          navigation: scopeResults.find((r) => r.result.navigation)?.result.navigation || null,
          // Specialist model scores are not calibrated or comparable. Do not
          // invent an aggregate confidence value for a combined answer.
          confidenceScore: undefined,
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
        promptPreview: null,
      }).catch((auditErr) => {
        console.warn('[SmartERP AI] Request audit event could not be recorded:', auditErr?.code || auditErr?.name || 'audit_error');
      });

      // Persist to CNC Enterprise AI Action Audit Trail
      const auditUserId = req.user?.userId || req.user?.id || '00000000-0000-0000-0000-000000000000';
      const userName = req.user?.name || 'Owner';
      if (companyId) {
        await pool.query(
          `INSERT INTO ai_action_audit_trail (company_id, user_id, user_name, prompt, ai_interpretation, workflow_type, execution_level, approval_status, result_summary, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, 'executed', $7, NOW())`,
          [String(companyId), String(auditUserId), userName, `AI request (${finalResult.activeModelScope || 'general'})`, 'AI response generated; business content redacted.', finalResult.activeModelScope || 'general', 'AI response generated; business content redacted.']
        ).catch(() => {});
      }

      finalResult.telemetry = {
        ...(finalResult.telemetry || {}),
        latencyMs,
        planTier,
      };

      res.json(finalResult);
    } catch (error) {
      const diagnostic = {
        code: typeof error?.code === 'string' ? error.code.slice(0, 40) : null,
        name: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error',
      };
      // PostgreSQL SQLSTATE diagnostics (including undefined columns) are safe
      // to log without request prompts, credentials, or parameter values.
      if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
        diagnostic.databaseMessage = String(error.message || '').slice(0, 240);
        if (error.column) diagnostic.column = String(error.column).slice(0, 100);
        if (error.table) diagnostic.table = String(error.table).slice(0, 100);
      }
      // Tool failures are wrapped to keep the public error stable. Preserve
      // only safe PostgreSQL metadata from the cause so schema errors remain
      // diagnosable without logging prompts, SQL parameters, or credentials.
      if (typeof error?.cause?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.cause.code)) {
        diagnostic.cause = { code: error.cause.code };
        if (error.cause.column) diagnostic.cause.column = String(error.cause.column).slice(0, 100);
        if (error.cause.table) diagnostic.cause.table = String(error.cause.table).slice(0, 100);
      }
      console.error("❌ SmartERP AI Agent Error:", diagnostic);
      const response = getAiErrorResponse(error);
      return res.status(response.status).json(response.body);
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
  async (req, res) => {
    try {
      const { toolName, params = {} } = req.body;

      if (!toolName) {
        return res.status(400).json({ error: "Tool name is required for action execution." });
      }

      {
        const blocked = findBlockedActionInput(params);
        if (blocked) {
          if (blocked.invalid) {
            return res.status(400).json({ error: 'Action parameters are too deeply nested.', code: 'INVALID_ACTION_PARAMS' });
          }
          const { emitSecurityEvent, SECURITY_EVENT_TYPES } = require("../utils/securityEmitter");
          emitSecurityEvent({
            companyId: req.user?.companyId || req.user?.company_id,
            userId: req.user?.userId || req.user?.id,
            eventType: SECURITY_EVENT_TYPES.PROMPT_INJECTION,
            severity: blocked.result.riskLevel || 'high',
            ipAddress: req.ip || req.headers?.['x-forwarded-for'],
            userAgent: req.headers?.['user-agent'],
            endpoint: '/api/ai/confirm-action',
            httpMethod: 'POST',
            statusCode: 400,
            metadata: {
              isSecurityThreat: true,
              category: blocked.result.category,
              reason: blocked.result.category,
              riskLevel: blocked.result.riskLevel,
              requestId: req.id || require('node:crypto').randomUUID(),
              paramPath: blocked.path,
              messageLength: blocked.length,
            },
          });
          return res.status(400).json({
            code: 'AI_PROMPT_BLOCKED',
            error: SAFE_PROMPT_REFUSAL,
          });
        }
      }

      const planTier = getPlanTier(req);
      const context = ContextEngine.buildContext(req, {}, planTier);
      const confirmedParams = { ...params, confirmed: true };

      const result = await pluginRegistry.execute(toolName, confirmedParams, context);
      res.json(result);
    } catch (error) {
      console.error("❌ AI Action Confirmation Error:", {
        code: typeof error?.code === 'string' ? error.code.slice(0, 40) : null,
        name: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error',
      });
      const response = getAiErrorResponse(error);
      return res.status(response.status).json(response.body);
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
  async (req, res) => {
    try {
      const message = req.sanitizedAiMessage;
      const planTier = getPlanTier(req);
      const context = ContextEngine.buildContext(req, {}, planTier);
      const result = await ReActEngine.run({ userPrompt: message, context });
      res.json({ reply: result.text });
    } catch (error) {
      const response = getAiErrorResponse(error);
      res.status(response.status).json(response.body);
    }
  }
);

module.exports = router;
