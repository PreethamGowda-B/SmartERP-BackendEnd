const ProviderFactory = require("../providers/provider.factory");
const ContextEngine = require("../context/context.engine");
const pluginRegistry = require("../plugins");
const MetricsService = require("../telemetry/metrics.service");
const { MAX_ARGUMENT_BYTES } = require('../plugins/toolArguments');

const MAX_TOOL_CALLS_PER_COMPLETION = 8;

function synthesizeToolResponse(messages, modulesUsed) {
  const toolMessages = messages.filter((m) => m.role === "tool");
  if (toolMessages.length === 0) {
    return null;
  }

  for (let i = toolMessages.length - 1; i >= 0; i--) {
    try {
      const data = JSON.parse(toolMessages[i].content);
      if (data.jobs && typeof data.jobs.completed === "number") {
        return `Based on live ERP records: **${data.jobs.completed}** completed jobs, **${data.jobs.in_progress}** in progress, and **${data.jobs.total}** total jobs in your company.`;
      }
      if (data.totalCount !== undefined && Array.isArray(data.jobs)) {
        return `Found **${data.totalCount}** job record(s) matching your request.`;
      }
      if (data.assigned_jobs && Array.isArray(data.assigned_jobs)) {
        return `You have **${data.summary?.active_jobs || 0}** active assigned job(s) and **${data.summary?.completed_jobs || 0}** completed job(s).`;
      }
      if (data.revenue) {
        return `Live Company Metrics: ₹${data.revenue.today} revenue today (₹${data.revenue.this_month} this month), ${data.jobs?.completed || 0} completed jobs, and ${data.employees?.active_count || 0} active employees.`;
      }
    } catch (e) {}
  }

  return `The ERP tool returned a response${modulesUsed.size ? ` from ${Array.from(modulesUsed).join(", ")}` : ""}, but I could not verify or format a usable result. No summary was produced; please open the related module or try a narrower question.`;
}

function getToolModuleName(functionName) {
  const plugin = pluginRegistry.plugins.find((entry) => entry.tools[functionName] || entry.skills[functionName]);
  return plugin?.module || plugin?.name || "SmartERP System";
}

class ReActEngine {
  /**
   * Main ReAct Agent Loop: Context -> Plan -> Function Calls -> Reason -> Format Payload
   * @param {Object} params
   * @param {string} params.userPrompt - User question or command
   * @param {Array} [params.history] - Chat history
   * @param {Object} params.context - Context object from ContextEngine
   * @param {string} [params.systemPromptOverride] - Optional pre-built system prompt
   * @returns {Promise<Object>} Structured AI response payload
   */
  static async run({ userPrompt, history = [], context, systemPromptOverride = null, modelScope = 'general', toolsEnabled = true }) {
    const startTime = Date.now();
    const provider = ProviderFactory.getProvider();
    const systemPrompt = systemPromptOverride || ContextEngine.generateSystemPrompt(context);
    const executionContext = { ...context, aiModelScope: modelScope };
    const availableTools = toolsEnabled ? pluginRegistry.getAvailableTools(executionContext) : [];

    // Build message trajectory
    const messages = [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({
        role: m.sender === "user" ? "user" : "assistant",
        content: m.content,
      })),
      { role: "user", content: userPrompt },
    ];

    let navigationCommand = null;
    let actionConfirmation = null;
    const modulesUsed = new Set();
    let maxIterations = 3; // Keep iterations focused and fast
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      const completion = await provider.generateCompletion({
        messages,
        tools: availableTools,
        temperature: 0.1,
      });

      const { content, toolCalls } = completion;

      if (toolCalls != null && !Array.isArray(toolCalls)) {
        const error = new Error('AI provider returned an invalid tool-call payload.');
        error.code = 'AI_TOOL_ARGUMENTS_INVALID';
        throw error;
      }
      if (Array.isArray(toolCalls) && toolCalls.length > MAX_TOOL_CALLS_PER_COMPLETION) {
        const error = new Error('AI provider returned too many tool calls in one response.');
        error.code = 'AI_TOOL_CALL_LIMIT_EXCEEDED';
        throw error;
      }

      if (!toolsEnabled && toolCalls?.length) {
        const error = new Error('Tool calls are disabled for document-only AI requests.');
        error.code = 'AI_DOCUMENT_ONLY_TOOL_CALL_BLOCKED';
        throw error;
      }

      // If no tool calls requested, LLM has completed its reasoning
      if (!toolCalls || toolCalls.length === 0) {
        let parsedPayload = null;
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedPayload = JSON.parse(jsonMatch[0]);
          }
        } catch (e) {}

        let responseText = parsedPayload?.text || content;
        if (!responseText || responseText.trim() === "" || responseText === "Completed operations." || responseText === "Operation processed.") {
          responseText = synthesizeToolResponse(messages, modulesUsed);
          if (!responseText) {
            const error = new Error('The model returned an empty response without completing a tool action.');
            error.code = 'AI_EMPTY_RESPONSE';
            throw error;
          }
        }

        const proposedWidget = parsedPayload?.widget || null;
        // Confirmation cards must carry a server-produced tool reference. A
        // model-written widget is not an executable action and must not be
        // rendered as one.
        const widget = proposedWidget?.type === "ACTION_CONFIRMATION"
          ? actionConfirmation
          : proposedWidget;

        let finalWidget = widget;
        if (!finalWidget && modulesUsed.has("AttendancePlugin")) {
          finalWidget = {
            type: "KPI_SUMMARY",
            title: "Today's Attendance Overview",
          };
        }

        return {
          text: responseText,
          widget: finalWidget || actionConfirmation,
          // Navigation is executable UI behavior; expose only destinations
          // returned by the registered navigation tool, never model prose.
          navigation: navigationCommand,
          // The model's prose alone is not a verified confidence signal. The
          // deterministic data resolvers publish confidence where appropriate.
          confidenceScore: undefined,
          sources: Array.from(modulesUsed),
          telemetry: {
            latencyMs: Date.now() - startTime,
            provider: provider.name,
            iterations: iteration,
          },
        };
      }

      // Execute requested tools in parallel
      messages.push({
        role: "assistant",
        content: content || "",
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const functionName = toolCall.function.name;
        let args = {};
        try {
          if (typeof toolCall.function.arguments === 'string'
              && Buffer.byteLength(toolCall.function.arguments, 'utf8') > MAX_ARGUMENT_BYTES) {
            const error = new Error('AI tool arguments exceed the supported size.');
            error.code = 'AI_TOOL_ARGUMENTS_INVALID';
            throw error;
          }
          args = typeof toolCall.function.arguments === "string"
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;
        } catch (err) {
          const error = new Error('AI model returned invalid arguments for an ERP tool.');
          error.code = 'AI_TOOL_ARGUMENTS_INVALID';
          throw error;
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          const error = new Error('AI model returned invalid arguments for an ERP tool.');
          error.code = 'AI_TOOL_ARGUMENTS_INVALID';
          throw error;
        }

        let toolResult;
        try {
          toolResult = await pluginRegistry.execute(functionName, args, executionContext);
        } catch (toolErr) {
          await MetricsService.logAIAuditEvent({
            userContext: context,
            toolName: functionName,
            params: args,
            status: "FAILED",
            error: toolErr?.code || toolErr?.name || 'tool_error',
          }).catch(() => {});
          const error = new Error('A required SmartERP data action could not be completed.');
          error.code = 'AI_TOOL_EXECUTION_FAILED';
          error.cause = toolErr;
          throw error;
        }

        // Audit telemetry is best-effort and must not turn a successful read
        // or completed action into a failed request.
        await MetricsService.logAIAuditEvent({
          userContext: context,
          toolName: functionName,
          params: args,
          status: "SUCCESS",
        }).catch((auditErr) => {
          console.warn('[SmartERP AI] Tool audit event could not be recorded:', auditErr?.code || auditErr?.name || 'audit_error');
        });

        // Track module source
        if (toolResult && toolResult.action === "NAVIGATE") {
          navigationCommand = { path: toolResult.path, label: toolResult.label };
        }

        if (toolResult && toolResult.type === "ACTION_CONFIRMATION_REQUIRED") {
          actionConfirmation = toolResult;
        }

        modulesUsed.add(getToolModuleName(functionName));

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        });
      }
    }

    const error = new Error('AI tool loop exceeded its safe iteration limit.');
    error.code = 'AI_AGENT_ITERATION_LIMIT';
    throw error;
  }
}

module.exports = ReActEngine;
