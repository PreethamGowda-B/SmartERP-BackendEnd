'use strict';

const { getAvailableAiModelScopes } = require('./aiModelEntitlements');

// Protected AI tools must hold their domain specialist entitlement even when
// the caller selects the general assistant. Unknown tools in these plugins fail closed.
const TOOL_SCOPES_BY_PLUGIN = Object.freeze({
  AttendancePlugin: Object.freeze({
    get_today_attendance: ['attendance'],
    assess_absenteeism_risk: ['attendance'],
  }),
  PayrollPlugin: Object.freeze({
    get_payroll_summary: ['payroll'],
    calculate_payroll: ['payroll'],
    validate_payroll_pre_run: ['payroll'],
  }),
  InventoryPlugin: Object.freeze({
    get_low_stock_items: ['inventory'],
    get_material_requests: ['inventory'],
    get_demand_forecasts: ['inventory'],
  }),
  FinancialPlugin: Object.freeze({
    get_revenue_analytics: ['finance'],
    get_unpaid_invoices: ['finance'],
    get_ar_aging_summary: ['finance'],
  }),
  GSTReconciliationPlugin: Object.freeze({
    get_gst_reconciliation_summary: ['gst'],
    list_unmatched_gst_invoices: ['gst'],
  }),
  LiveSummaryPlugin: Object.freeze({
    get_owner_metrics: ['executive'],
    get_employee_personal_summary: ['attendance', 'hr', 'inventory'],
    get_hr_summary: ['attendance', 'hr'],
  }),
});

function getRequiredAiToolScopes(pluginName, toolName) {
  const pluginTools = TOOL_SCOPES_BY_PLUGIN[pluginName];
  if (!pluginTools) return [];
  return Object.hasOwn(pluginTools, toolName) ? pluginTools[toolName] : null;
}

function hasAiToolEntitlement(planTier, pluginName, toolName, modelScope) {
  const pluginTools = TOOL_SCOPES_BY_PLUGIN[pluginName];
  // Plugins outside this protected-module map retain their existing tool-level
  // RBAC and plan filtering; mapped plugins fail closed for unknown tool names.
  if (!pluginTools) return true;
  const requiredScopes = getRequiredAiToolScopes(pluginName, toolName);
  if (requiredScopes === null) return false;
  if (!requiredScopes.length) return true;
  const available = getAvailableAiModelScopes(planTier);
  if (!Array.isArray(available) || !requiredScopes.every((scope) => available.includes(scope))) return false;

  const activeScopes = Array.isArray(modelScope) ? modelScope : [modelScope];
  const normalizedScopes = activeScopes.map((scope) => String(scope || '').toLowerCase());
  // A plan entitlement alone must not expose specialist data through the
  // general assistant. Multi-domain personal summaries may run under any of
  // their explicitly required specialists, but never under general.
  return normalizedScopes.some((scope) => requiredScopes.includes(scope));
}

module.exports = { TOOL_SCOPES_BY_PLUGIN, getRequiredAiToolScopes, hasAiToolEntitlement };
