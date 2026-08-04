const ProviderFactory = require("../providers/provider.factory");
const ContextEngine = require("../context/context.engine");
const pluginRegistry = require("../plugins");
const MetricsService = require("../telemetry/metrics.service");

function synthesizeToolResponse(messages, modulesUsed) {
  const toolMessages = messages.filter((m) => m.role === "tool");
  if (toolMessages.length === 0) {
    return "SmartERP Intelligence processed your request using live system data.";
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

  return `Live ERP query completed. Retrieved records from ${Array.from(modulesUsed).join(", ") || "database"}.`;
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
  static async run({ userPrompt, history = [], context, systemPromptOverride = null }) {
    const startTime = Date.now();
    const provider = ProviderFactory.getProvider();
    const systemPrompt = systemPromptOverride || ContextEngine.generateSystemPrompt(context);
    const availableTools = pluginRegistry.getAvailableTools(context);

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
        }

        const widget = parsedPayload?.widget || null;

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
          navigation: parsedPayload?.navigation || navigationCommand,
          confidenceScore: 0.98,
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
          args = typeof toolCall.function.arguments === "string"
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;
        } catch (err) {
          args = {};
        }

        try {
          const toolResult = await pluginRegistry.execute(functionName, args, context);

          // Audit Log Entry
          await MetricsService.logAIAuditEvent({
            userContext: context,
            toolName: functionName,
            params: args,
            status: "SUCCESS",
          });

          // Track module source
          if (toolResult && toolResult.action === "NAVIGATE") {
            navigationCommand = { path: toolResult.path, label: toolResult.label };
          }

          if (toolResult && toolResult.type === "ACTION_CONFIRMATION_REQUIRED") {
            actionConfirmation = toolResult;
          }

          modulesUsed.add(functionName.split("_")[0] || "SmartERP System");

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        } catch (toolErr) {
          await MetricsService.logAIAuditEvent({
            userContext: context,
            toolName: functionName,
            params: args,
            status: "FAILED",
            error: toolErr.message,
          });

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: toolErr.message }),
          });
        }
      }
    }

    const fallbackText = synthesizeToolResponse(messages, modulesUsed);

    return {
      text: fallbackText,
      widget: actionConfirmation,
      navigation: navigationCommand,
      confidenceScore: 0.98,
      sources: Array.from(modulesUsed),
      telemetry: {
        latencyMs: Date.now() - startTime,
        provider: provider.name,
        iterations: iteration,
      },
    };
  }
}

module.exports = ReActEngine;
