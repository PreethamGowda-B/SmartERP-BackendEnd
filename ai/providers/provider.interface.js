/**
 * Abstract Base Class for AI Model Providers.
 * Provides a unified API interface across Groq, OpenAI, Anthropic, Gemini, etc.
 */
class BaseAIProvider {
  constructor(name) {
    this.name = name;
  }

  /**
   * Generates text completion / JSON response.
   * @param {Object} params
   * @param {Array} params.messages - Chat messages
   * @param {Array} [params.tools] - Available tool definitions
   * @param {number} [params.temperature] - Temperature (0.0 to 1.0)
   * @returns {Promise<Object>} Unified response object { content, toolCalls, usage }
   */
  async generateCompletion(params) {
    throw new Error(`generateCompletion must be implemented by ${this.name} provider`);
  }
}

module.exports = BaseAIProvider;
