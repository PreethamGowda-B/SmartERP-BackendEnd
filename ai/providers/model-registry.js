'use strict';

// Curated models currently executed through Groq. Keep external IDs here so
// routing and fallback policy have one auditable source of truth.
const MODELS = Object.freeze({
  general: Object.freeze({ provider: 'groq', modelId: 'openai/gpt-oss-20b', capabilities: Object.freeze(['text', 'tool_use', 'structured_output']), fallback: 'reasoning', active: true }),
  reasoning: Object.freeze({ provider: 'groq', modelId: 'openai/gpt-oss-120b', capabilities: Object.freeze(['text', 'reasoning', 'tool_use', 'structured_output']), fallback: 'general', active: true }),
  // Groq currently lists Qwen 3.8 27B as a preview model with vision inputs.
  // Keep it isolated to image-capable requests and never use it as a text fallback.
  vision: Object.freeze({ provider: 'groq', modelId: 'qwen/qwen3.8-27b', capabilities: Object.freeze(['text', 'vision']), fallback: null, active: true }),
});

function resolveModel(alias = 'reasoning') {
  const model = MODELS[alias];
  if (!model?.active) {
    const error = new Error('The requested AI model capability is not configured.');
    error.code = 'AI_MODEL_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  return model;
}

function routeTask({ task = 'general', modelOverride = null } = {}) {
  if (modelOverride) {
    const match = Object.entries(MODELS).find(([, entry]) => entry.modelId === modelOverride);
    if (match) return { alias: match[0], ...match[1] };
    const error = new Error('The requested model is not in the approved model registry.');
    error.code = 'AI_MODEL_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  const alias = task === 'general' ? 'general' : task === 'vision' ? 'vision' : 'reasoning';
  return { alias, ...resolveModel(alias) };
}

module.exports = { MODELS, resolveModel, routeTask };
