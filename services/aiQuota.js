'use strict';

// Compatibility shim for older callers of the former AI per-hour quota.
// AI message counts are no longer subscription-limited; model access is enforced
// independently by aiModelEntitlements.js.
async function consumeAIRequest() {
  return { allowed: true, unlimited: true, limit: null, count: null };
}

module.exports = { consumeAIRequest };
