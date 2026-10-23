const BaseAIProvider = require("./provider.interface");
const Groq = require("groq-sdk");
const { groqConcurrencyLimiter } = require("../../utils/asyncLimiter");

function sanitizeToolArgs(rawArgs) {
  let args = {};
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs);
    } catch (e) {
      return rawArgs;
    }
  } else if (typeof rawArgs === "object" && rawArgs !== null) {
    args = { ...rawArgs };
  } else {
    return rawArgs;
  }

  for (const key of Object.keys(args)) {
    if (typeof args[key] === "string" && !isNaN(args[key]) && args[key].trim() !== "") {
      const num = Number(args[key]);
      if (!isNaN(num)) {
        args[key] = num;
      }
    }
  }
  return typeof rawArgs === "string" ? JSON.stringify(args) : args;
}

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
        arguments: sanitizeToolArgs(rawArgs),
      },
    });
  }
  return toolCalls;
}

const FALLBACK_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
  "groq/compound",
];

class GroqProvider extends BaseAIProvider {
  constructor() {
    super("Groq");
    if (!process.env.GROQ_API_KEY || !process.env.GROQ_API_KEY.trim()) {
      const error = new Error("The AI provider is not configured.");
      error.code = "AI_PROVIDER_NOT_CONFIGURED";
      error.statusCode = 503;
      throw error;
    }
    this.client = new Groq({
      apiKey: process.env.GROQ_API_KEY,
      // Keep provider latency bounded. The SDK defaults to 60 seconds and two
      // retries, which can outlive the browser request and multiply load when
      // the user retries an unanswered prompt.
      timeout: 10000,
      maxRetries: 0,
    });
    this.defaultModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  }

  async generateCompletion({ messages, tools = [], temperature = 0.2, model = null }) {
    return groqConcurrencyLimiter.run(async () => {
      // Clean up previous assistant messages in trajectory to strip raw pseudo-XML tags
      const sanitizedMessages = messages.map((m) => {
        if (m.role === "assistant" && typeof m.content === "string") {
          const cleaned = m.content.replace(/<function=\w+\s*\{[\s\S]*?\}<\/function>/g, "").trim();
          return { ...m, content: cleaned };
        }
        return m;
      });

      // One fallback is enough for a model-specific issue. Trying every model
      // in sequence made a single prompt wait through several provider calls.
      const candidateModels = model
        ? [model]
        : [...new Set([this.defaultModel, ...FALLBACK_MODELS.filter(m => m !== this.defaultModel)])].slice(0, 2);
      let lastError = null;

      for (const modelToTry of candidateModels) {
        const payload = {
          model: modelToTry,
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

        // Sanitize any tool call arguments returned directly by Groq
        if (toolCalls && toolCalls.length > 0) {
          toolCalls = toolCalls.map((tc) => {
            if (tc.function && tc.function.arguments) {
              return {
                ...tc,
                function: {
                  ...tc.function,
                  arguments: sanitizeToolArgs(tc.function.arguments),
                },
              };
            }
            return tc;
          });
        }

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
        lastError = err;
        const errStr = JSON.stringify(err || {});
        const errMsg = err?.message || String(err || "");
        const status = Number(err?.status || err?.statusCode || err?.error?.status || 0);
        const isTimeout = err?.name === "AbortError" || err?.name === "TimeoutError" || err?.code === "ETIMEDOUT";

        // Intercept failed_generation 400 errors containing tool call pseudo-XML or JSON output
        if (err?.error?.error?.failed_generation || errStr.includes("failed_generation") || errStr.includes("tool_<function") || errMsg.includes("<function=") || errStr.includes("tool call validation failed")) {
          const rawGen = err?.error?.error?.failed_generation || "";
          if (rawGen) {
            try {
              const parsedGen = JSON.parse(rawGen);
              const extractedText = parsedGen?.arguments?.text || parsedGen?.text;
              if (extractedText) {
                return {
                  content: extractedText,
                  toolCalls: [],
                  usage: {},
                  model: modelToTry,
                };
              }
            } catch (_) {}
          }

          const parsedCalls = parsePseudoToolCalls(errStr + " " + errMsg + " " + rawGen);
          if (parsedCalls.length > 0) {
            return {
              content: "",
              toolCalls: parsedCalls,
              usage: {},
              model: modelToTry,
            };
          }
        }
        // Credentials, account quota, and timeouts affect the provider/account,
        // not just the selected model. Trying another model cannot resolve them.
        if (status === 401 || status === 403 || status === 429 || isTimeout) break;
        console.warn(`⚠️ Groq model '${modelToTry}' failed (code=${String(err?.code || status || 'provider_error').slice(0, 60)}) — trying next candidate...`);
      }
    }
    const error = new Error("The AI provider is temporarily unavailable.");
    error.code = "AI_PROVIDER_UNAVAILABLE";
    error.statusCode = 503;
    // Keep only a provider error code for diagnostics; do not attach or return
    // request/configuration data that could contain sensitive information.
    if (lastError?.code) error.providerErrorCode = String(lastError.code).slice(0, 80);
    throw error;
  });
}
}

module.exports = GroqProvider;
