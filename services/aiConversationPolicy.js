'use strict';

function policyError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function getAuthenticatedIdentity(user) {
  const userId = user?.id || user?.userId;
  const companyId = user?.companyId || user?.company_id;
  if (!userId || !companyId) {
    throw policyError(401, 'AI_CONVERSATION_AUTH_CONTEXT_REQUIRED', 'Authenticated user and company context are required.');
  }
  return { userId: String(userId), companyId: String(companyId) };
}

/**
 * Conversation access is always tied to both the authenticated user and company.
 * Call this after loading a conversation with a company-scoped query; this is a
 * second application-layer guard, not a replacement for query scoping or RLS.
 */
function assertConversationOwner({ user, conversation }) {
  const identity = getAuthenticatedIdentity(user);
  if (!conversation || String(conversation.companyId ?? conversation.company_id) !== identity.companyId
      || String(conversation.ownerUserId ?? conversation.owner_user_id) !== identity.userId) {
    // Do not reveal whether another user's conversation ID exists.
    throw policyError(404, 'AI_CONVERSATION_NOT_FOUND', 'Conversation not found.');
  }
  return identity;
}

function normalizeConversationPage({ page = 1, limit = 25 } = {}) {
  const parsedPage = Number(page);
  const parsedLimit = Number(limit);
  if (!Number.isSafeInteger(parsedPage) || parsedPage < 1) {
    throw policyError(400, 'AI_CONVERSATION_PAGINATION_INVALID', 'Page must be a positive integer.');
  }
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    throw policyError(400, 'AI_CONVERSATION_PAGINATION_INVALID', 'Limit must be between 1 and 100.');
  }
  const offset = (parsedPage - 1) * parsedLimit;
  if (!Number.isSafeInteger(offset) || offset > 1_000_000) {
    throw policyError(400, 'AI_CONVERSATION_PAGINATION_INVALID', 'Requested page is outside the supported history range.');
  }
  return { page: parsedPage, limit: parsedLimit, offset };
}

function getRetentionCutoff({ now = new Date(), retentionDays }) {
  const days = Number(retentionDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw policyError(500, 'AI_CONVERSATION_RETENTION_INVALID', 'Conversation retention policy is invalid.');
  }
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw policyError(500, 'AI_CONVERSATION_CLOCK_INVALID', 'Conversation retention clock is invalid.');
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

module.exports = { getAuthenticatedIdentity, assertConversationOwner, normalizeConversationPage, getRetentionCutoff };
