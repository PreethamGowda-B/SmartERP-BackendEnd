'use strict';

const USER_MODEL_SCOPES = Object.freeze([
  'general', 'cnc', 'finance', 'inventory', 'attendance', 'payroll', 'hr', 'gst', 'executive',
]);

const MODEL_SCOPES_BY_TIER = Object.freeze({
  starter: Object.freeze(['general']),
  professional: Object.freeze(['general', 'cnc', 'inventory', 'attendance', 'hr']),
  enterprise: USER_MODEL_SCOPES,
});

function getAvailableAiModelScopes(planTier) {
  return MODEL_SCOPES_BY_TIER[planTier] || null;
}

function resolveAiModelScopes({ planTier, requestedScopes = [], autoMode = true, prompt, detectModelScope }) {
  const allowedScopes = getAvailableAiModelScopes(planTier);
  if (!allowedScopes) return { ok: false, status: 503, code: 'AI_PLAN_UNAVAILABLE' };

  if (!Array.isArray(requestedScopes)) return { ok: false, status: 400, code: 'AI_MODEL_SELECTION_INVALID' };
  const uniqueRequested = [...new Set(requestedScopes)];
  if (uniqueRequested.some((scope) => !USER_MODEL_SCOPES.includes(scope))) {
    return { ok: false, status: 400, code: 'AI_MODEL_SELECTION_INVALID' };
  }
  const unavailable = uniqueRequested.filter((scope) => !allowedScopes.includes(scope));
  if (unavailable.length) {
    return { ok: false, status: 403, code: 'AI_MODEL_NOT_INCLUDED', unavailableScopes: unavailable };
  }
  if (uniqueRequested.length) return { ok: true, scopes: uniqueRequested, autoSelectedModel: null };

  const detectedScope = autoMode === false ? 'general' : (detectModelScope?.(prompt) || 'general');
  const resolvedScope = allowedScopes.includes(detectedScope) ? detectedScope : 'general';
  return {
    ok: true,
    scopes: [resolvedScope],
    autoSelectedModel: autoMode === false ? null : resolvedScope,
  };
}

module.exports = { USER_MODEL_SCOPES, MODEL_SCOPES_BY_TIER, getAvailableAiModelScopes, resolveAiModelScopes };
