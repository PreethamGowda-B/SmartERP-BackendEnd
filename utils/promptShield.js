/**
 * utils/promptShield.js
 *
 * Anti-Prompt-Injection & Context Sanitization Guard for SmartERP Security AI.
 * Treats all security telemetry, user agents, endpoints, and event metadata as
 * untrusted, adversarial input. Sanitizes, redacts, and wraps input in strict
 * XML boundaries to prevent prompt injection, delimiter escapes, and jailbreaks.
 */

// Common prompt injection & jailbreak patterns
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior)\s+instructions/i,
  /you\s+are\s+now\s+(in\s+)?developer\s+mode/i,
  /system\s*:\s*you\s+are/i,
  /act\s+as\s+(an?\s+)?(unrestricted|root|unfiltered)/i,
  /reveal\s+(the\s+)?(system\s+prompt|secret\s+key|jwt_secret|api_key)/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\[SYSTEM_PROMPT\]/i,
  /\[ADMIN_OVERRIDE\]/i,
];

// Sensitive keys that must be redacted recursively
const REDACTED_KEYS = [
  'password',
  'password_hash',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'jwt_secret',
  'authorization',
  'otp',
  'credit_card',
  'cvv',
  'api_key',
  'private_key',
];

/**
 * Recursively redacts sensitive keys from any object or array.
 *
 * @param {*} data
 * @returns {*} Sanitized data
 */
function redactSensitiveData(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    // Redact bearer tokens or high-entropy JWT strings if present in string text
    return data
      .replace(/Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/gi, 'Bearer [REDACTED_JWT]')
      .replace(/ey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g, '[REDACTED_JWT]');
  }
  if (Array.isArray(data)) {
    return data.map(redactSensitiveData);
  }
  if (typeof data === 'object') {
    const clean = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (REDACTED_KEYS.some((bad) => lowerKey.includes(bad))) {
        clean[key] = '[REDACTED]';
      } else {
        clean[key] = redactSensitiveData(value);
      }
    }
    return clean;
  }
  return data;
}

/**
 * Checks if text contains known prompt-injection triggers.
 *
 * @param {string} text
 * @returns {boolean}
 */
function containsPromptInjection(text) {
  if (!text || typeof text !== 'string') return false;
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Sanitizes untrusted telemetry strings before injection into LLM context.
 * Neutralizes markdown delimiters and wraps in strict XML boundary tags.
 *
 * @param {string} rawText - Untrusted text
 * @param {string} [tagLabel='untrusted_telemetry'] - XML tag name
 * @returns {string} Safe, isolated string block
 */
function sanitizeForPrompt(rawText, tagLabel = 'untrusted_telemetry') {
  if (!rawText) return `<${tagLabel}></${tagLabel}>`;

  let safe = String(rawText);

  // Redact bearer tokens
  safe = redactSensitiveData(safe);

  // Neutralize delimiters that could fool Markdown / LLM parsers
  safe = safe
    .replace(/```/g, "'''")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '[REMOVED_SCRIPT]')
    .replace(/<\/?system>/gi, '[SYSTEM_TAG_STRIPPED]')
    .replace(/<\/?instruction>/gi, '[INSTRUCTION_TAG_STRIPPED]');

  // Flag prompt injection if detected
  const isSuspicious = containsPromptInjection(safe);
  const flagAttr = isSuspicious ? ' prompt_injection_detected="true"' : '';

  return `<${tagLabel}${flagAttr}>\n${safe.trim()}\n</${tagLabel}>`;
}

/**
 * Formats structured evidence into a safe, isolated context block for Gemini.
 *
 * @param {Object} incident - Incident database record
 * @param {Array} events - Correlated telemetry events
 * @returns {string} Sanitized LLM context
 */
function buildSanitizedIncidentContext(incident, events = []) {
  const cleanIncident = redactSensitiveData(incident);
  const cleanEvents = redactSensitiveData(events);

  return `
=== SECURITY INCIDENT UNDER INVESTIGATION ===
Incident ID: ${cleanIncident.id}
Threat Category: ${cleanIncident.threat_category}
Deterministic Severity: ${cleanIncident.severity}
Deterministic Risk Score: ${cleanIncident.risk_score} (DO NOT OVERWRITE)
Source IP: ${cleanIncident.source_ip || 'N/A'}
Affected User ID: ${cleanIncident.target_user_id || 'N/A'}
Affected Company ID: ${cleanIncident.company_id || 'Platform-wide'}
First Seen: ${cleanIncident.first_seen_at}
Last Seen: ${cleanIncident.last_seen_at}
Total Event Count in Window: ${cleanIncident.event_count}

=== UNTRUSTED TELEMETRY EVIDENCE ===
${sanitizeForPrompt(JSON.stringify(cleanEvents, null, 2), 'correlated_events')}
`;
}

module.exports = {
  redactSensitiveData,
  containsPromptInjection,
  sanitizeForPrompt,
  buildSanitizedIncidentContext,
};
