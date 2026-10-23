'use strict';

const DOCUMENT_ACTIONS = new Set(['search', 'upload', 'list', 'reindex', 'download', 'delete']);
const DOCUMENT_READER_ROLES = new Set(['owner', 'admin']);

function accessError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/**
 * Initial release policy: only authenticated Owner/Admin users can use company
 * documents. This is a policy helper only; no route is enabled by importing it.
 */
function assertDocumentAction({ user, companyId, action, document = null }) {
  const userId = user?.id || user?.userId;
  const userCompanyId = user?.companyId || user?.company_id;
  if (!userId || !userCompanyId || !companyId) {
    throw accessError(401, 'AI_DOCUMENT_AUTH_CONTEXT_REQUIRED', 'Authenticated user and company context are required.');
  }
  if (String(userCompanyId) !== String(companyId)) {
    throw accessError(403, 'AI_DOCUMENT_COMPANY_FORBIDDEN', 'Document access is not available for this company.');
  }
  if (!DOCUMENT_READER_ROLES.has(String(user.role || '').toLowerCase())) {
    throw accessError(403, 'AI_DOCUMENT_ROLE_FORBIDDEN', 'Document access is limited to authorized company administrators.');
  }
  if (!DOCUMENT_ACTIONS.has(action)) {
    throw accessError(400, 'AI_DOCUMENT_ACTION_INVALID', 'Document action is not supported.');
  }
  if (['reindex', 'download', 'delete'].includes(action) && !document) {
    throw accessError(404, 'AI_DOCUMENT_NOT_FOUND', 'Document not found.');
  }
  if (document) {
    const documentCompanyId = document.companyId ?? document.company_id;
    if (String(documentCompanyId) !== String(userCompanyId)) {
      throw accessError(404, 'AI_DOCUMENT_NOT_FOUND', 'Document not found.');
    }
    const deleted = Boolean(document.deletedAt ?? document.deleted_at);
    const superseded = Boolean(document.supersededBy ?? document.superseded_by);
    if (deleted || superseded) {
      throw accessError(404, 'AI_DOCUMENT_NOT_FOUND', 'Document not found.');
    }
  }
  return { userId: String(userId), companyId: String(userCompanyId), role: String(user.role).toLowerCase(), action };
}

module.exports = { DOCUMENT_ACTIONS, DOCUMENT_READER_ROLES, assertDocumentAction };
