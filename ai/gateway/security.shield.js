/**
 * SmartERP Security Shield
 * Defends against prompt injection attempts, cross-company data access,
 * and malicious input vectors before reaching the AI Orchestrator.
 */

class SecurityShield {
  static sanitizeInput(input) {
    if (!input || typeof input !== "string") {
      return "";
    }

    let clean = input.trim();

    if (clean.length > 2000) {
      throw new Error("Input payload exceeds maximum character limit of 2000.");
    }

    // Detect cross-company query attempts
    const crossCompanyPatterns = [
      /show me company [a-z0-9_\-\s]+'s/i,
      /compare my company with another company/i,
      /show all customers across every company/i,
      /show all employees across all companies/i,
      /access other company data/i,
      /list all companies database/i,
    ];

    for (const pattern of crossCompanyPatterns) {
      if (pattern.test(clean)) {
        throw new Error(
          "I can't access or disclose information belonging to another company. Your account can only access data that your organization is authorized to view."
        );
      }
    }

    // Detect prompt injection / system override patterns
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
