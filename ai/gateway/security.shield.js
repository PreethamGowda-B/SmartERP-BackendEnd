/**
 * SmartERP Security Shield
 * Advanced multi-layer adversarial AI guard protecting against prompt injection,
 * system prompt exfiltration, credential extraction, cross-tenant data tampering,
 * and delimiter breakouts before reaching AI orchestration models.
 */

class SecurityShield {
  /**
   * Evaluates if a query is a harmless educational, conceptual, or defense question
   * to prevent false positives on benign user inquiries.
   *
   * @param {string} text - Lowercase trimmed input text
   * @returns {boolean} True if query is educational or inquiring about security
   */
  static isEducationalOrInquiry(text) {
    const inquiryPrefixes = [
      'what is',
      'what are',
      'how to prevent',
      'how do i protect',
      'how can we prevent',
      'how does',
      'explain',
      'tell me about',
      'best practices for',
      'difference between',
      'definition of',
    ];

    const hasInquiryPrefix = inquiryPrefixes.some((prefix) => text.startsWith(prefix));
    const isSecurityQuestion = /\b(sql injection|prompt injection|cross-site|xss|csrf|idor|rbac|encryption|defense|firewall)\b/i.test(text);

    // If it asks about a security concept educationally and does NOT command an imperative override
    if (hasInquiryPrefix && isSecurityQuestion) {
      const hasImperativeCommand = /\b(ignore instructions|developer mode|dan mode|reveal the|dump database|drop table)\b/i.test(text);
      return !hasImperativeCommand;
    }

    return false;
  }

  /**
   * Comprehensive inspection of user prompt.
   * Returns structured threat analysis without throwing exceptions.
   *
   * @param {string} input - User message
   * @param {Object} [context={}] - Optional request context (user, companyId)
   * @returns {{ blocked: boolean, isAttack: boolean, riskLevel: string, category: string, reason: string, sanitizedText: string }}
   */
  static inspectPrompt(input, context = {}) {
    if (!input || typeof input !== "string") {
      return {
        blocked: false,
        isAttack: false,
        riskLevel: 'none',
        category: 'NONE',
        reason: '',
        sanitizedText: '',
      };
    }

    // 1. Sanitize control characters and normalize
    let clean = input.replace(/\0/g, '').trim();

    if (clean.length > 3000) {
      return {
        blocked: true,
        isAttack: false,
        riskLevel: 'low',
        category: 'PAYLOAD_TOO_LARGE',
        reason: 'Input payload exceeds maximum character limit of 3000.',
        sanitizedText: clean.slice(0, 3000),
      };
    }

    const lower = clean.toLowerCase();

    // 2. Check false-positive defense whitelist
    if (this.isEducationalOrInquiry(lower)) {
      return {
        blocked: false,
        isAttack: false,
        riskLevel: 'none',
        category: 'EDUCATIONAL_INQUIRY',
        reason: '',
        sanitizedText: clean,
      };
    }

    // 3. System Instruction Overrides & Jailbreaks (Critical / High)
    const overridePatterns = [
      /(ignore|disregard|forget|bypass|override)\s+(all\s+)?((previous|prior|initial|system|developer|hidden)\s+)*(instructions|prompts|rules|directives|guidelines)/i,
      /you\s+are\s+now\s+(in\s+)?(developer\s+mode|dan\s+mode|unrestricted|god\s+mode|evil\s+mode|jailbroken)/i,
      /act\s+as\s+(an?\s+)?(unrestricted|jailbroken|unfiltered|ruleless|evil|hacked)\s+(ai|assistant|model|agent)/i,
      /pretend\s+(you\s+have\s+no\s+rules|there\s+are\s+no\s+(restrictions|guidelines|guardrails)|you\s+are\s+unfiltered)/i,
      /system\s*:\s*(you\s+are|override|ignore)/i,
      /(bypass|disable|turn\s+off)\s+(all\s+)?(permission\s+checks|security\s+rules|safety\s+filters|rbac)/i,
      /stop\s+being\s+(an?\s+)?(assistant|ai)\s+and\s+execute/i,
    ];

    for (const pattern of overridePatterns) {
      if (pattern.test(clean)) {
        return {
          blocked: true,
          isAttack: true,
          riskLevel: 'critical',
          category: 'SYSTEM_INSTRUCTION_OVERRIDE',
          reason: 'Security Alert: System instruction override or adversarial jailbreak pattern detected.',
          sanitizedText: clean,
        };
      }
    }

    // 4. Secret & Credential Extraction (Critical)
    const secretExfiltrationPatterns = [
      /(reveal|show|dump|print|leak|output|display|give)\s+(me\s+)?(the\s+)?(system\s+prompt|jwt_secret|api_key|database_url|db_password|supabase_key|\.env|env\s+variables|master_key|private_key)/i,
      /(what\s+is|tell\s+me)\s+(the\s+)?(jwt_secret|supabase_service_role|database\s+password|admin\s+password|encryption_key)/i,
      /\b(process\.env|process\.exit|require\(['"]child_process['"]\))\b/i,
      /\b(jwt_secret|database_url|supabase_service_role_key)\b/i,
      /echo\s+\$(JWT_SECRET|DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY|SESSION_SECRET)/i,
    ];

    for (const pattern of secretExfiltrationPatterns) {
      if (pattern.test(clean)) {
        return {
          blocked: true,
          isAttack: true,
          riskLevel: 'critical',
          category: 'CREDENTIAL_EXFILTRATION',
          reason: 'Security Alert: Unauthorized credential, environment variable, or system prompt extraction attempt.',
          sanitizedText: clean,
        };
      }
    }

    // 5. Destructive SQL / Database Operations (High)
    const destructiveSqlPatterns = [
      /\b(drop\s+(database|table)|truncate\s+table|delete\s+from\s+users|alter\s+table\s+users)\b/i,
      /\bunion\s+(all\s+)?select\b/i,
      /;\s*drop\s+table/i,
      /;\s*delete\s+from/i,
      /'\s*or\s*'?1'?\s*=\s*'?1/i,
    ];

    for (const pattern of destructiveSqlPatterns) {
      if (pattern.test(clean)) {
        return {
          blocked: true,
          isAttack: true,
          riskLevel: 'high',
          category: 'SQL_INJECTION',
          reason: 'Security Alert: SQL injection or destructive database operation pattern detected.',
          sanitizedText: clean,
        };
      }
    }

    // 6. Cross-Tenant / Cross-Company Data Extraction (High)
    const crossCompanyPatterns = [
      /show\s+(me\s+)?company\s+[a-z0-9_\-\s]+'s/i,
      /compare\s+my\s+company\s+with\s+another\s+company/i,
      /show\s+all\s+(customers|employees|invoices|payroll|users)\s+across\s+every\s+company/i,
      /access\s+other\s+company('s)?\s+data/i,
      /list\s+all\s+companies\s+(in\s+the\s+)?database/i,
      /dump\s+all\s+(tenants|companies|organizations)/i,
    ];

    for (const pattern of crossCompanyPatterns) {
      if (pattern.test(clean)) {
        return {
          blocked: true,
          isAttack: true,
          riskLevel: 'high',
          category: 'CROSS_TENANT_EXFILTRATION',
          reason: "I can't access or disclose information belonging to another company. Your account can only access data that your organization is authorized to view.",
          sanitizedText: clean,
        };
      }
    }

    // 7. Delimiter & Parsing Breakout (High)
    const delimiterPatterns = [
      /<\|im_start\|>|<\|im_end\|>|\[SYSTEM_PROMPT\]|\[ADMIN_OVERRIDE\]|<<SYS>>|\[INST\]|\[\/INST\]/i,
      /<\/?system>/i,
    ];

    for (const pattern of delimiterPatterns) {
      if (pattern.test(clean)) {
        return {
          blocked: true,
          isAttack: true,
          riskLevel: 'high',
          category: 'DELIMITER_BREAKOUT',
          reason: 'Security Alert: LLM framing delimiter or system prompt tag escape detected.',
          sanitizedText: clean,
        };
      }
    }

    return {
      blocked: false,
      isAttack: false,
      riskLevel: 'none',
      category: 'NONE',
      reason: '',
      sanitizedText: clean,
    };
  }

  /**
   * Legacy backward-compatible sanitizeInput method.
   * Throws Error with security metadata if input is blocked.
   *
   * @param {string} input - User message
   * @returns {string} Clean sanitized input
   * @throws {Error} If prompt violates security rules
   */
  static sanitizeInput(input) {
    const analysis = this.inspectPrompt(input);
    if (analysis.blocked) {
      const err = new Error(analysis.reason);
      err.isSecurityThreat = analysis.isAttack;
      err.riskLevel = analysis.riskLevel;
      err.category = analysis.category;
      throw err;
    }
    return analysis.sanitizedText;
  }
}

module.exports = SecurityShield;
