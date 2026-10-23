'use strict';

const { getAvailableAiModelScopes, USER_MODEL_SCOPES } = require('./aiModelEntitlements');

const FAST_PATH_POLICIES = Object.freeze({
  assigned_jobs: Object.freeze({ scopes: ['general'], roles: ['employee'], boundary: 'assigned' }),
  completed_jobs: Object.freeze({ scopes: ['general'], roles: ['owner', 'admin', 'hr'], boundary: 'company' }),
  active_jobs: Object.freeze({ scopes: ['general'], roles: ['owner', 'admin', 'hr', 'employee'], boundary: 'role-dependent' }),
  attendance: Object.freeze({ scopes: ['attendance'], roles: ['owner', 'admin', 'hr', 'employee'], boundary: 'role-dependent' }),
  payroll: Object.freeze({ scopes: ['payroll'], roles: ['owner', 'admin'], boundary: 'company' }),
  inventory: Object.freeze({ scopes: ['inventory'], roles: ['owner', 'admin', 'hr'], boundary: 'company' }),
  finance: Object.freeze({ scopes: ['finance'], roles: ['owner', 'admin'], boundary: 'company' }),
  finance_unpaid_invoices: Object.freeze({ scopes: ['finance'], roles: ['owner', 'admin'], boundary: 'company' }),
  gst: Object.freeze({ scopes: ['gst'], roles: ['owner', 'admin'], boundary: 'company' }),
  finance_gst_mixed: Object.freeze({ scopes: ['finance', 'gst'], roles: ['owner', 'admin'], boundary: 'company' }),
  pending_leave: Object.freeze({ scopes: ['hr'], roles: ['owner', 'admin', 'hr', 'employee'], boundary: 'role-dependent' }),
});

const PROTECTED_INTENT_PATTERN = /\b(attendance|clock(?:ed)?\s*in|absent|late arrival|payroll|salary|payout|inventory|stock|materials?|gst|gstr|tax|invoice|revenue|receivables?|finance|financial|leave|job|jobs|task|tasks|employee|employees|customer|customers)\b/i;

function containsAny(prompt, patterns) {
  return patterns.some((pattern) => pattern.test(prompt));
}

function classifyFinanceGstIntent(prompt) {
  const finance = /\b(finance|financial|revenue|invoice|invoices|payment|payments|receivable|receivables|cash\s*flow|billing)\b/i.test(prompt);
  const gst = /\b(gst|gstr|tax|taxation|tax\s+reconciliation|reconcile|reconciliation)\b/i.test(prompt);
  if (!finance && !gst) return null;
  if (finance && gst) {
    const explicitlyCombined = /\b(both|combined|together|along\s+with|and|plus)\b/i.test(prompt);
    return explicitlyCombined ? 'finance_gst_mixed' : 'finance_gst_ambiguous';
  }
  return gst ? 'gst' : 'finance';
}

function classifyAiFastPathIntent(prompt, role) {
  const text = String(prompt || '').trim();
  const normalizedRole = String(role || '').toLowerCase();
  const lower = text.toLowerCase();

  if (normalizedRole === 'employee' && /\b(my|mine|assigned\s+to\s+me)\b/.test(lower) && /\b(jobs?|tasks?)\b/.test(lower)) {
    return { key: 'assigned_jobs', protected: true, deterministic: true };
  }

  if (/\b(support|customer\s+care|help\s+desk)\b/.test(lower)) {
    return { key: 'support', protected: false, deterministic: true };
  }

  const financeGstIntent = classifyFinanceGstIntent(text);
  if (financeGstIntent) {
    if (financeGstIntent === 'finance_gst_ambiguous') return { key: financeGstIntent, protected: true, clarification: true };
    if (financeGstIntent === 'finance' && /\b(unpaid|overdue|pending)\b/i.test(text) && /\binvoices?\b/i.test(text)) {
      return { key: 'finance_unpaid_invoices', protected: true, deterministic: false, providerScopes: ['finance'] };
    }
    return {
      key: financeGstIntent,
      protected: true,
      deterministic: financeGstIntent === 'finance',
      providerScopes: financeGstIntent === 'finance_gst_mixed'
        ? ['finance', 'gst']
        : [financeGstIntent],
    };
  }

  if (/\b(payroll|salary|payout|wage|wages)\b/i.test(text)) return { key: 'payroll', protected: true, deterministic: true };

  if (/\b(pending\s+leave|leave\s+requests?\s+(?:pending|waiting)|leave\s+request\s+waiting)\b/i.test(text)) {
    return { key: 'pending_leave', protected: true, deterministic: true };
  }

  if (containsAny(text, [/\b(attendance)\b/i, /\bwho\s+is\s+(?:present|absent|late)\b/i, /\bclocked\s+in\b/i, /\blate\s+arrival\b/i])) {
    const requestsCompanyData = normalizedRole === 'employee' && containsAny(lower, [
      /\b(company|team|staff|employees|everyone|all\s+workers)\b/i,
      /\bwho\s+is\s+(?:present|absent|late)\b/i,
      /\b(?:other|another)\s+employee\b/i,
    ]);
    const requestsAnotherPerson = normalizedRole === 'employee' && containsAny(text, [
      /\b(?:his|her|their)\s+attendance\b/i,
      /\b(?!(?:my|today|yesterday|this|the|our)\b)[a-z][a-z'-]{2,}(?:\s+[a-z][a-z'-]{2,})?'s\s+attendance\b/i,
      /\battendance\s+(?:for|of)\s+(?!me\b|my\b)[a-z][a-z'-]{2,}/i,
    ]);
    return {
      key: 'attendance',
      protected: true,
      deterministic: true,
      recordScope: normalizedRole === 'employee' ? 'personal' : 'company',
      forbiddenTarget: requestsCompanyData || requestsAnotherPerson,
    };
  }

  if (/\b(completed\s+jobs?|jobs?\s+completed|how\s+many\s+jobs?\s+(?:are\s+)?completed)\b/i.test(text)) {
    return { key: 'completed_jobs', protected: true, deterministic: true };
  }

  if (/\b(active\s+jobs?|in[ -]?progress\s+jobs?)\b/i.test(text)) return { key: 'active_jobs', protected: true, deterministic: true };

  if (/\b(inventory|low\s+stock|stock|materials?)\b/i.test(text)) return { key: 'inventory', protected: true, deterministic: true };

  if (PROTECTED_INTENT_PATTERN.test(text)) return { key: 'unknown_protected', protected: true, deterministic: false };
  return { key: 'general', protected: false, deterministic: false };
}

function authorizeAiFastPath({ intent, role, companyId, userId, plan, planTier, modelScopes = [], autoMode = true }) {
  const normalizedRole = String(role || '').toLowerCase();
  if (!intent?.protected) return { allowed: true, requiredScopes: [] };
  if (intent.clarification) return { allowed: false, clarification: true, code: 'AI_INTENT_CLARIFICATION_REQUIRED' };
  if (intent.key === 'unknown_protected' || !FAST_PATH_POLICIES[intent.key]) {
    return { allowed: false, status: 403, code: 'AI_INTENT_UNAVAILABLE', message: 'This SmartERP data request is not available through the assistant.' };
  }

  const policy = FAST_PATH_POLICIES[intent.key];
  if (!plan || plan.features?.ai_assistant !== true) {
    return { allowed: false, status: 503, code: 'AI_PLAN_UNAVAILABLE', message: 'The AI access policy could not be verified.' };
  }
  if (!planTier || !getAvailableAiModelScopes(planTier)) {
    return { allowed: false, status: 503, code: 'AI_PLAN_UNAVAILABLE', message: 'The AI access policy could not be verified.' };
  }
  if (!policy.roles.includes(normalizedRole)) {
    return { allowed: false, status: 403, code: 'AI_ROLE_FORBIDDEN', message: 'Your role is not authorized to access this SmartERP data.' };
  }
  if (intent.forbiddenTarget) {
    return { allowed: false, status: 403, code: 'AI_RECORD_SCOPE_FORBIDDEN', message: 'You can only access your own attendance information.' };
  }
  if (!companyId || !userId) {
    return { allowed: false, status: 403, code: 'AI_AUTH_CONTEXT_UNAVAILABLE', message: 'Your SmartERP access context could not be verified.' };
  }

  if (!Array.isArray(modelScopes)) {
    return { allowed: false, status: 400, code: 'AI_MODEL_SELECTION_INVALID', message: 'The selected AI model is invalid.' };
  }
  const requested = intent.providerScopes
    || (intent.key === 'pending_leave' && normalizedRole === 'employee' ? ['general'] : policy.scopes);
  const selected = modelScopes.length ? modelScopes : (autoMode === false ? ['general'] : []);
  if (selected.some((scope) => !USER_MODEL_SCOPES.includes(scope))) {
    return { allowed: false, status: 400, code: 'AI_MODEL_SELECTION_INVALID', message: 'The selected AI model is invalid.' };
  }

  const available = getAvailableAiModelScopes(planTier);
  const required = [...new Set(requested)];
  if (required.some((scope) => !available.includes(scope))) {
    return { allowed: false, status: 403, code: 'AI_MODEL_NOT_INCLUDED', message: 'This SmartERP data feature is not included in your company plan.' };
  }
  if (selected.some((scope) => !available.includes(scope))) {
    return { allowed: false, status: 403, code: 'AI_MODEL_NOT_INCLUDED', message: 'One or more selected AI models are not included in your company plan.' };
  }
  if (selected.length && required.some((scope) => !selected.includes(scope))) {
    return { allowed: false, status: 403, code: 'AI_MODEL_INTENT_MISMATCH', message: 'Select the AI specialist required for this SmartERP data request.' };
  }

  return {
    allowed: true,
    key: intent.key,
    requiredScopes: required,
    selectedScopes: selected,
    runDeterministic: Boolean(intent.deterministic) && selected.length <= required.length,
  };
}

module.exports = {
  FAST_PATH_POLICIES,
  classifyAiFastPathIntent,
  authorizeAiFastPath,
  classifyFinanceGstIntent,
};
