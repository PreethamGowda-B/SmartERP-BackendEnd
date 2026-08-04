const BaseAIProvider = require("./provider.interface");
const Groq = require("groq-sdk");
const { groqConcurrencyLimiter } = require("../../utils/asyncLimiter");

function parsePseudoToolCalls(str) {
  if (!str || typeof str !== "string") return [];
  const toolCalls = [];
  const regex = /<function=(\w+)\s*(\{[\s\S]*?\})?\s*<\/function>/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    const fnName = match[1];
    const rawArgs = match[2] || "{}";
    toolCalls.push({
      id: `call_${Math.random().toString(36).substring(2, 9)}`,
      type: "function",
      function: {
        name: fnName,
        arguments: rawArgs,
      },
    });
  }
  return toolCalls;
}

class GroqProvider extends BaseAIProvider {
  constructor() {
    super("Groq");
    this.client = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
    this.defaultModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  }

  async generateCompletion({ messages, tools = [], temperature = 0.2 }) {
    return groqConcurrencyLimiter.run(async () => {
      // Clean up previous assistant messages in trajectory to strip raw pseudo-XML tags
      const sanitizedMessages = messages.map((m) => {
        if (m.role === "assistant" && typeof m.content === "string") {
          const cleaned = m.content.replace(/<function=\w+\s*\{[\s\S]*?\}<\/function>/g, "").trim();
          return { ...m, content: cleaned };
        }
        return m;
      });

      const payload = {
        model: this.defaultModel,
        messages: sanitizedMessages,
        temperature,
      };

      if (tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
      }

      try {
        const response = await this.client.chat.completions.create(payload);
        const choice = response.choices[0];
        const message = choice.message;

        let content = message.content || "";
        let toolCalls = message.tool_calls || [];

        // Check if Llama returned pseudo-XML function call in content
        if (content.includes("<function=")) {
          const parsedCalls = parsePseudoToolCalls(content);
          if (parsedCalls.length > 0) {
            toolCalls = [...toolCalls, ...parsedCalls];
            content = content.replace(/<function=\w+\s*\{[\s\S]*?\}<\/function>/g, "").trim();
          }
        }

        return {
          content,
          toolCalls,
          usage: response.usage || {},
          model: response.model,
        };
      } catch (err) {
        const errStr = JSON.stringify(err || {});
        const errMsg = err?.message || String(err || "");

        // Intercept Llama 3.3 failed_generation 400 errors containing tool call pseudo-XML
        if (errStr.includes("failed_generation") || errStr.includes("tool_<function") || errMsg.includes("<function=")) {
          const parsedCalls = parsePseudoToolCalls(errStr + " " + errMsg);
          if (parsedCalls.length > 0) {
            return {
              content: "",
              toolCalls: parsedCalls,
              usage: {},
              model: this.defaultModel,
            };
          }
        }
        throw err;
      }
    });
  }
}

module.exports = GroqProvider;
