const BaseAIProvider = require("./provider.interface");
const Groq = require("groq-sdk");

class GroqProvider extends BaseAIProvider {
  constructor() {
    super("Groq");
    this.client = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
    this.defaultModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  }

  async generateCompletion({ messages, tools = [], temperature = 0.2 }) {
    const payload = {
      model: this.defaultModel,
      messages,
      temperature,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    const response = await this.client.chat.completions.create(payload);
    const choice = response.choices[0];
    const message = choice.message;

    return {
      content: message.content || "",
      toolCalls: message.tool_calls || [],
      usage: response.usage || {},
      model: response.model,
    };
  }
}

module.exports = GroqProvider;
