/**
 * SmartERP Security Shield
 * Defends against prompt injection attempts, system prompt overrides,
 * and malicious input vectors before reaching the AI Orchestrator.
 */

class SecurityShield {
  static sanitizeInput(input) {
    if (!input || typeof input !== "string") {
      return "";
    }

    // Trim excessive whitespace
    let clean = input.trim();

    // Check input length
    if (clean.length > 2000) {
      throw new Error("Input payload exceeds maximum character limit of 2000.");
    }

    // Detect prompt injection patterns (system overrides, ignore previous instructions)
    const injectionPatterns = [
      /ignore previous instructions/i,
      /ignore all previous system prompts/i,
      /you are now in developer mode/i,
      /override system rules/i,
      /bypass permission checks/i,
      /drop database/i,
      /delete from users/i,
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(clean)) {
        throw new Error("Security Alert: System instruction override or SQL injection pattern detected.");
      }
    }

    return clean;
  }
}

module.exports = SecurityShield;
