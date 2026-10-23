'use strict';

const SecurityShield = require('../ai/gateway/security.shield');
const { randomUUID } = require('node:crypto');

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
      if (historyField && req.body?.[historyField] !== undefined) {
        if (!Array.isArray(req.body[historyField]) || req.body[historyField].length > 20) {
          return res.status(400).json({ error: 'Chat history is invalid.' });
        }
        req.body[historyField] = req.body[historyField].map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.content !== 'string') {
            throw Object.assign(new Error('Chat history is invalid.'), { inputValidationFailure: true });
          }
          return { ...entry, content: sanitizeText(entry.content) };
        });
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
        code: 'AI_PROMPT_BLOCKED',
        error: err?.inputValidationFailure ? err.message : (err?.message || 'The message was rejected by the AI safety checks.'),
      });
    }
  };
}

module.exports = { createAiPromptGuard };
