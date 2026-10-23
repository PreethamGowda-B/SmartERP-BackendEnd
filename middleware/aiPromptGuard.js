'use strict';

const SecurityShield = require('../ai/gateway/security.shield');
const { randomUUID } = require('node:crypto');

const SAFE_PROMPT_REFUSAL = "Sorry, I can't follow instructions that attempt to bypass my security rules. I can still help with your normal SmartERP tasks.";

function createAiPromptGuard({
  field = 'message',
  sanitizedProperty = field === 'message' ? 'sanitizedAiMessage' : 'sanitizedAiPrompt',
  historyField = null,
  contextField = null,
  rootContextFields = [],
  sanitizeInput = (message) => SecurityShield.sanitizeInput(message),
  emitSecurityEvent = null,
} = {}) {
  return function validateAiPrompt(req, res, next) {
    const message = req.body?.[field];
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    const emitAttack = (err, length) => {
      if (err?.isSecurityThreat !== true) return;
      try {
        const emit = emitSecurityEvent || require('../utils/securityEmitter').emitSecurityEvent;
        emit({
          companyId: req.user?.companyId || req.user?.company_id,
          userId: req.user?.userId || req.user?.id,
          eventType: 'prompt.injection_attempt',
          severity: err?.riskLevel || 'high',
          ipAddress: req.ip || req.headers?.['x-forwarded-for'],
          userAgent: req.headers?.['user-agent'],
          endpoint: req.originalUrl || req.path,
          httpMethod: req.method,
          statusCode: 400,
          metadata: {
            isSecurityThreat: true,
            category: err?.category || 'PROMPT_SAFETY_VALIDATION_REJECTED',
            reason: err?.category || 'prompt_safety_validation_rejected',
            riskLevel: err?.riskLevel || 'high',
            requestId: req.id || randomUUID(),
            messageLength: length,
          },
        });
      } catch (_) {
        // Prompt rejection must still fail closed if telemetry cannot be loaded.
      }
    };
    const sanitizeText = (value) => {
      try { return sanitizeInput(value); }
      catch (err) { err.inputLength = value.length; throw err; }
    };

    try {
      req[sanitizedProperty] = sanitizeText(message);

      // Prior turns and UI context are also client-controlled. Validate them
      // before they are inserted into model history or the generated system prompt.
      // Old turns are untrusted context: omit an unsafe/oversized prior turn
      // instead of rejecting every later, otherwise-safe request in the chat.
      if (historyField && req.body?.[historyField] !== undefined) {
        if (!Array.isArray(req.body[historyField])) {
          return res.status(400).json({ error: 'Chat history is invalid.' });
        }
        const safeHistory = [];
        for (const entry of req.body[historyField].slice(-20)) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.content !== 'string') {
            throw Object.assign(new Error('Chat history is invalid.'), { inputValidationFailure: true });
          }
          try {
            const content = sanitizeText(entry.content);
            safeHistory.push({ sender: entry.sender === 'user' ? 'user' : 'assistant', content });
          } catch (err) {
            if (err?.isSecurityThreat === true || err?.category === 'PAYLOAD_TOO_LARGE') continue;
            throw err;
          }
        }
        req.body[historyField] = safeHistory;
      }

      const sanitizeContextValue = (value) => typeof value === 'string' ? sanitizeText(value) : value;
      if (contextField && req.body?.[contextField] && typeof req.body[contextField] === 'object') {
        const context = { ...req.body[contextField] };
        for (const key of ['currentPortal', 'portal', 'currentModule', 'module', 'currentPagePath', 'pagePath', 'currentPage']) {
          if (context[key] !== undefined) context[key] = sanitizeContextValue(context[key]);
        }
        req.body[contextField] = context;
      }
      for (const key of rootContextFields) {
        if (req.body?.[key] !== undefined) req.body[key] = sanitizeContextValue(req.body[key]);
      }
      return next();
    } catch (err) {
      emitAttack(err, typeof err?.inputLength === 'number' ? err.inputLength : message.length);
      return res.status(400).json({
        code: err?.inputValidationFailure ? 'AI_HISTORY_INVALID' : 'AI_PROMPT_BLOCKED',
        error: err?.inputValidationFailure ? err.message : (err?.isSecurityThreat === true ? SAFE_PROMPT_REFUSAL : (err?.message || 'The message was rejected by the AI safety checks.')),
      });
    }
  };
}

module.exports = { createAiPromptGuard, SAFE_PROMPT_REFUSAL };
