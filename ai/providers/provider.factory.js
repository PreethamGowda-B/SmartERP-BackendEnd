const GroqProvider = require("./groq.provider");

class ProviderFactory {
  static getProvider() {
    const providerName = (process.env.AI_PROVIDER || "groq").toLowerCase();

    switch (providerName) {
      case "groq":
      default:
        return new GroqProvider();
    }
  }
}

module.exports = ProviderFactory;
