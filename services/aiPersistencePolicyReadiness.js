'use strict';

const EXPECTED_POLICIES = new Map([
  ['ai_documents', 'ai_documents_owner_scope'],
  ['ai_document_chunks', 'ai_document_chunks_owner_scope'],
  ['ai_conversations', 'ai_conversations_owner_scope'],
  ['ai_conversation_messages', 'ai_conversation_messages_owner_scope'],
]);

function hasCompanyScope(sql, column = 'company_id') {
  return new RegExp(`(?:\\b[a-z_][a-z_0-9]*\\.)?${column}\\s*=\\s*nullif\\s*\\(\\s*current_setting\\s*\\(\\s*'app\\.current_company_id'`, 'i').test(sql);
}

function hasRoleScope(sql) {
  return /current_setting\s*\(\s*'app\.current_role'(?:\s*::\s*text)?\s*,\s*true\s*\)\s*=\s*any\s*\(\s*array\s*\[\s*'owner'(?:\s*::\s*text)?\s*,\s*'admin'(?:\s*::\s*text)?\s*\]\s*\)/i.test(sql)
    || /current_setting\s*\(\s*'app\.current_role'(?:\s*::\s*text)?\s*,\s*true\s*\)\s+in\s*\(\s*'owner'\s*,\s*'admin'\s*\)/i.test(sql);
}

function hasRetentionWindow(sql, alias = '') {
  const field = alias ? `${alias}\\.retention_until` : '(?:[a-z_][a-z_0-9]*\\.)?retention_until';
  const expression = String(sql).toLowerCase().replace(/::(?:text|timestamptz|timestamp with time zone)\b/g, '').replace(/[\s()]/g, '');
  return new RegExp(`${field}isnullor${field}>now`, 'i').test(expression);
}

function countOr(sql) {
  return (String(sql).match(/\bor\b/gi) || []).length;
}

function hasCurrentUserScope(sql, column = 'owner_user_id') {
  return new RegExp(`(?:\\b[a-z_][a-z_0-9]*\\.)?${column}\\s*=\\s*nullif\\s*\\(\\s*current_setting\\s*\\(\\s*'app\\.current_user_id'`, 'i').test(sql);
}

function hasParentDocumentScope(sql, { active, currentCompanyRequired }) {
  const required = [
    /exists\s*\([\s\S]*?from\s+(?:public\.)?ai_documents\s+(?:as\s+)?d\b/i,
    /d\.id\s*=\s*ai_document_chunks\.document_id/i,
    /d\.company_id\s*=\s*ai_document_chunks\.company_id/i,
    /d\.deleted_at\s+is\s+null/i,
  ];
  if (currentCompanyRequired) required.push(/d\.company_id\s*=\s*nullif\s*\(\s*current_setting\s*\(\s*'app\.current_company_id'/i);
  if (!required.every((pattern) => pattern.test(sql)) || !hasRetentionWindow(sql, 'd')) return false;
  return !active || /d\.superseded_by\s+is\s+null/i.test(sql);
}

function hasConversationParentScope(sql) {
  return /exists\s*\([\s\S]*?from\s+(?:public\.)?ai_conversations\s+(?:as\s+)?c\b/i.test(sql)
    && /c\.id\s*=\s*ai_conversation_messages\.conversation_id/i.test(sql)
    && /c\.company_id\s*=\s*ai_conversation_messages\.company_id/i.test(sql)
    && /c\.owner_user_id\s*=\s*ai_conversation_messages\.owner_user_id/i.test(sql)
    && /c\.deleted_at\s+is\s+null/i.test(sql);
}

function rolesArePublic(roles) {
  return Array.isArray(roles) && roles.length === 1 && String(roles[0]).toLowerCase() === 'public';
}

function validatePolicy(policy) {
  if (!policy || policy.permissive !== 'PERMISSIVE' || policy.command !== 'ALL' || !rolesArePublic(policy.roles)) return false;
  const qual = String(policy.using || '');
  const check = String(policy.withCheck || '');
  if (!qual || !check || !hasCompanyScope(qual) || !hasCompanyScope(check)) return false;

  switch (policy.tableName) {
    case 'ai_documents':
      return policy.policyName === 'ai_documents_owner_scope'
        && hasRoleScope(qual) && hasRoleScope(check)
        && hasRetentionWindow(qual) && hasRetentionWindow(check)
        && countOr(qual) === 1 && countOr(check) === 1
        && /deleted_at\s+is\s+null/i.test(qual)
        && /superseded_by\s+is\s+null/i.test(qual)
        // Preserve lifecycle writes: updates may soft-delete or supersede a currently visible row.
        && !/deleted_at|superseded_by/i.test(check);
    case 'ai_document_chunks':
      return policy.policyName === 'ai_document_chunks_owner_scope'
        && hasRoleScope(qual) && hasRoleScope(check)
        && hasParentDocumentScope(qual, { active: true, currentCompanyRequired: true })
        && hasParentDocumentScope(check, { active: false, currentCompanyRequired: false })
        && countOr(qual) === 1 && countOr(check) === 1
        // The migration 044 write check intentionally permits re-index and supersession cleanup.
        && !/d\.superseded_by/i.test(check);
    case 'ai_conversations':
      return policy.policyName === 'ai_conversations_owner_scope'
        && hasCurrentUserScope(qual) && hasCurrentUserScope(check)
        && countOr(qual) === 0 && countOr(check) === 0;
    case 'ai_conversation_messages':
      return policy.policyName === 'ai_conversation_messages_owner_scope'
        && hasCurrentUserScope(qual) && hasCurrentUserScope(check)
        && hasConversationParentScope(qual) && hasConversationParentScope(check)
        && countOr(qual) === 0 && countOr(check) === 0;
    default:
      return false;
  }
}

function aiPersistencePoliciesAreReady(policies) {
  if (!Array.isArray(policies) || policies.length !== EXPECTED_POLICIES.size) return false;
  const seen = new Set();
  for (const policy of policies) {
    if (!EXPECTED_POLICIES.has(policy?.tableName) || seen.has(policy.tableName) || !validatePolicy(policy)) return false;
    seen.add(policy.tableName);
  }
  return seen.size === EXPECTED_POLICIES.size;
}

module.exports = { aiPersistencePoliciesAreReady };
