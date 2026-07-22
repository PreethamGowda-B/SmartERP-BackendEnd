const ProviderFactory = require("../providers/provider.factory");
const ContextEngine = require("../context/context.engine");
const pluginRegistry = require("../plugins");

class ReActEngine {
  /**
   * Main ReAct Agent Loop: Context -> Plan -> Function Calls -> Reason -> Format Payload
   * @param {Object} params
   * @param {string} params.userPrompt - User question or command
   * @param {Array} [params.history] - Chat history
   * @param {Object} params.context - Context object from ContextEngine
   * @returns {Promise<Object>} Structured AI response payload
   */
  static async run({ userPrompt, history = [], context }) {
    const startTime = Date.now();
    const provider = ProviderFactory.getProvider();
    const systemPrompt = ContextEngine.generateSystemPrompt(context);
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
    let maxIterations = 5; // Prevent runaway tool loops
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      const completion = await provider.generateCompletion({
        messages,
        tools: availableTools,
        temperature: 0.2,
      });

      const { content, toolCalls } = completion;

      // If no tool calls requested, LLM has completed its reasoning
      if (!toolCalls || toolCalls.length === 0) {
        let parsedPayload = null;
        try {
          // Attempt parsing JSON payload if LLM formatted it as JSON
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedPayload = JSON.parse(jsonMatch[0]);
          }
        } catch (e) {
          // Fallback to text format
        }

        const responseText = parsedPayload?.text || content || "Operation processed.";
        const widget = parsedPayload?.widget || null;

        // Auto-detect widget if returning tabular / list data and no widget was built
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
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: toolErr.message }),
          });
        }
      }
    }

    return {
      text: "Completed operations.",
      widget: actionConfirmation,
      navigation: navigationCommand,
      confidenceScore: 0.95,
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
