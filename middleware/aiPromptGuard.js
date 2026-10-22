'use strict';

const SecurityShield = require('../ai/gateway/security.shield');

function createAiPromptGuard({
  sanitizeInput = (message) => SecurityShield.sanitizeInput(message),
  emitSecurityEvent = null,
} = {}) {
  return function validateAiPrompt(req, res, next) {
    const message = req.body?.message;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message prompt is required.' });
    }

    try {
      req.sanitizedAiMessage = sanitizeInput(message);
      return next();
    } catch (err) {
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
            reason: err?.category || 'prompt_safety_validation_rejected',
            messageLength: message.length,
          },
        });
      } catch (_) {
        // Prompt rejection must still fail closed if telemetry cannot be loaded.
      }
      return res.status(400).json({
        code: 'AI_PROMPT_BLOCKED',
        error: err?.message || 'The message was rejected by the AI safety checks.',
      });
    }
  };
}

module.exports = { createAiPromptGuard };
